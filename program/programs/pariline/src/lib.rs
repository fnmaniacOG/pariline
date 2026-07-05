//! PariLine: parimutuel World Cup 1X2 markets settled trustlessly against
//! TxLINE's on-chain verified scores (txoracle Merkle roots).
//!
//! Lifecycle: create_market -> bet (until kickoff) -> propose_settlement
//! (anyone, with Merkle proofs; latest-timestamp-wins inside a challenge
//! window) -> finalize -> claim.
//!
//! Trust model: no admin key. The only trusted party is TxODDS publishing
//! score Merkle roots on-chain; settlement proofs are verified against them.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke},
};

declare_id!("3LQjPerfx6ezVbe7dV4WEwUyySrA5S55arje3ParJGMi");

/// txoracle `validate_stat` anchor discriminator (from the devnet IDL).
pub const VALIDATE_STAT_DISC: [u8; 8] = [107, 197, 232, 90, 191, 136, 105, 185];

/// txoracle devnet program (TxLINE data oracle).
pub const TXORACLE_ID: Pubkey =
    anchor_lang::pubkey!("6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J");

/// How long after a settlement proposal anyone may counter it with a proof
/// carrying a later score timestamp (protects against settling on a
/// mid-match score).
pub const CHALLENGE_WINDOW_SECS: i64 = 6 * 60 * 60;
/// Earliest a settlement may be proposed: kickoff + regulation + stoppage.
pub const MIN_SETTLE_DELAY_SECS: i64 = 110 * 60;

pub const OUTCOME_HOME: u8 = 0;
pub const OUTCOME_DRAW: u8 = 1;
pub const OUTCOME_AWAY: u8 = 2;

/// TxLINE stat keys, encoded (period * 1000) + base_key. Base 1 and 2 with no
/// period offset = full-game total goals for participant 1 / participant 2.
pub const STAT_GOALS_P1: u32 = 1;
pub const STAT_GOALS_P2: u32 = 2;

#[program]
pub mod pariline {
    use super::*;

    /// Permissionless: open a 1X2 market for a TxLINE fixture.
    pub fn create_market(ctx: Context<CreateMarket>, fixture_id: i64, kickoff_ts: i64) -> Result<()> {
        require!(kickoff_ts > Clock::get()?.unix_timestamp, ErrorCode::KickoffInPast);
        let m = &mut ctx.accounts.market;
        m.fixture_id = fixture_id;
        m.kickoff_ts = kickoff_ts;
        m.pools = [0; 3];
        m.state = MarketState::Open;
        m.proposed_outcome = 0;
        m.proposed_score_ts = 0;
        m.challenge_deadline = 0;
        m.bump = ctx.bumps.market;
        Ok(())
    }

    /// Stake lamports on an outcome. Locks automatically at kickoff.
    pub fn bet(ctx: Context<Bet>, outcome: u8, amount: u64) -> Result<()> {
        require!(outcome <= OUTCOME_AWAY, ErrorCode::BadOutcome);
        require!(amount > 0, ErrorCode::ZeroAmount);
        let m = &mut ctx.accounts.market;
        require!(m.state == MarketState::Open, ErrorCode::MarketNotOpen);
        require!(Clock::get()?.unix_timestamp < m.kickoff_ts, ErrorCode::MarketLocked);

        anchor_lang::system_program::transfer(
            CpiContext::new(
                System::id(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.bettor.to_account_info(),
                    to: m.to_account_info(),
                },
            ),
            amount,
        )?;

        m.pools[outcome as usize] = m.pools[outcome as usize]
            .checked_add(amount).ok_or(ErrorCode::Overflow)?;

        let p = &mut ctx.accounts.position;
        p.market = m.key();
        p.owner = ctx.accounts.bettor.key();
        p.outcome = outcome;
        p.amount = p.amount.checked_add(amount).ok_or(ErrorCode::Overflow)?;
        p.claimed = false;
        Ok(())
    }

    /// Permissionless settlement proposal backed by TxLINE Merkle proofs of
    /// both teams' goal totals. Verification path (CPI into txoracle vs
    /// self-verification against its roots PDA) is stubbed pending the
    /// compute-unit feasibility result.
    ///
    /// Latest-score-timestamp-wins: within the challenge window anyone can
    /// replace the proposal with a proof carrying a later `score_ts`, so a
    /// mid-match snapshot can always be beaten by the full-time one.
    pub fn propose_settlement(
        ctx: Context<ProposeSettlement>,
        claimed_outcome: u8,
        proof: SettlementProof,
    ) -> Result<()> {
        require!(claimed_outcome <= OUTCOME_AWAY, ErrorCode::BadOutcome);
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        require!(
            m.state == MarketState::Open || m.state == MarketState::Proposed,
            ErrorCode::MarketNotOpen
        );
        require!(now >= m.kickoff_ts + MIN_SETTLE_DELAY_SECS, ErrorCode::TooEarly);
        require!(proof.summary.fixture_id == m.fixture_id, ErrorCode::WrongFixture);
        if m.state == MarketState::Proposed {
            require!(now <= m.challenge_deadline, ErrorCode::ChallengeOver);
            // >= not >: with the goal stat keys pinned above, two proofs at the
            // same batch timestamp prove the same leaves, so an equal-timestamp
            // replacement is idempotent, and this lets a correct proof replace
            // one from the same final batch.
            require!(
                proof.summary.update_stats.max_timestamp >= m.proposed_score_ts,
                ErrorCode::StaleProof
            );
        }

        // CPI into txoracle validate_stat: proves both goal stats against the
        // on-chain roots AND evaluates (goals_p1 - goals_p2) against the
        // predicate implied by the claimed outcome. ~117k CU measured.
        verify_outcome_via_txoracle(
            ctx.accounts.txoracle.to_account_info(),
            ctx.accounts.daily_scores_roots.to_account_info(),
            &proof,
            claimed_outcome,
        )?;

        m.proposed_outcome = claimed_outcome;
        m.proposed_score_ts = proof.summary.update_stats.max_timestamp;
        if m.state == MarketState::Open {
            m.challenge_deadline = now + CHALLENGE_WINDOW_SECS;
        }
        m.state = MarketState::Proposed;
        Ok(())
    }

    /// After the challenge window, lock in the outcome.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let m = &mut ctx.accounts.market;
        require!(m.state == MarketState::Proposed, ErrorCode::NothingProposed);
        require!(Clock::get()?.unix_timestamp > m.challenge_deadline, ErrorCode::ChallengeOpen);
        m.state = MarketState::Settled;
        Ok(())
    }

    /// Winner takes stake * total / winning_pool (parimutuel, no fee).
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        let m = &ctx.accounts.market;
        let p = &mut ctx.accounts.position;
        require!(m.state == MarketState::Settled, ErrorCode::NotSettled);
        require!(!p.claimed, ErrorCode::AlreadyClaimed);
        require!(p.outcome == m.proposed_outcome, ErrorCode::LosingPosition);

        let total: u64 = m.pools.iter().try_fold(0u64, |a, x| a.checked_add(*x))
            .ok_or(ErrorCode::Overflow)?;
        let winning_pool = m.pools[m.proposed_outcome as usize];
        let payout = (p.amount as u128)
            .checked_mul(total as u128).ok_or(ErrorCode::Overflow)?
            .checked_div(winning_pool as u128).ok_or(ErrorCode::Overflow)? as u64;

        p.claimed = true;
        ctx.accounts.market.sub_lamports(payout)?;
        ctx.accounts.owner.add_lamports(payout)?;
        Ok(())
    }
}

/// CPI into txoracle `validate_stat` with predicate
/// (goals_p1 - goals_p2) {>|==|<} 0 per the claimed outcome. Errors unless
/// txoracle returns true, i.e. unless both Merkle proofs check out against
/// its daily roots AND the score matches the claim.
fn verify_outcome_via_txoracle<'a>(
    txoracle: AccountInfo<'a>,
    roots: AccountInfo<'a>,
    proof: &SettlementProof,
    claimed_outcome: u8,
) -> Result<()> {
    require!(proof.stat_p1.stat_to_prove.key == STAT_GOALS_P1, ErrorCode::WrongStat);
    require!(proof.stat_p2.stat_to_prove.key == STAT_GOALS_P2, ErrorCode::WrongStat);
    // Both stats must come from the same proven event (same leaf set).
    require!(
        proof.stat_p1.event_stat_root == proof.stat_p2.event_stat_root,
        ErrorCode::WrongStat
    );

    let comparison = match claimed_outcome {
        OUTCOME_HOME => Comparison::GreaterThan,
        OUTCOME_AWAY => Comparison::LessThan,
        _ => Comparison::EqualTo,
    };

    // args: ts, fixture_summary, fixture_proof, main_tree_proof, predicate,
    //       stat_a, stat_b: Option, op: Option
    fn ser<T: AnchorSerialize>(v: &T, out: &mut Vec<u8>) -> Result<()> {
        v.serialize(out).map_err(|_| error!(ErrorCode::VerificationFailed))
    }
    let mut data = VALIDATE_STAT_DISC.to_vec();
    ser(&proof.ts, &mut data)?;
    ser(&proof.summary, &mut data)?;
    ser(&proof.fixture_proof, &mut data)?;
    ser(&proof.main_tree_proof, &mut data)?;
    ser(&TraderPredicate { threshold: 0, comparison }, &mut data)?;
    ser(&proof.stat_p1, &mut data)?;
    ser(&Some(proof.stat_p2.clone()), &mut data)?;
    ser(&Some(BinaryExpression::Subtract), &mut data)?;

    let ix = Instruction {
        program_id: TXORACLE_ID,
        accounts: vec![AccountMeta::new_readonly(roots.key(), false)],
        data,
    };
    invoke(&ix, &[roots, txoracle])?;

    let (pid, ret) = get_return_data().ok_or(ErrorCode::VerificationFailed)?;
    require!(pid == TXORACLE_ID, ErrorCode::VerificationFailed);
    require!(ret.first() == Some(&1u8), ErrorCode::VerificationFailed);
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum Comparison { GreaterThan, LessThan, EqualTo }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum BinaryExpression { Add, Subtract }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TraderPredicate { pub threshold: i32, pub comparison: Comparison }

// ---- txoracle-mirroring types (layouts match the devnet IDL) ----

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofNode { pub hash: [u8; 32], pub is_right_sibling: bool }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoreStat { pub key: u32, pub value: i32, pub period: i32 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresUpdateStats { pub update_count: i32, pub min_timestamp: i64, pub max_timestamp: i64 }

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ScoresBatchSummary {
    pub fixture_id: i64,
    pub update_stats: ScoresUpdateStats,
    pub events_sub_tree_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct StatTerm {
    pub stat_to_prove: ScoreStat,
    pub event_stat_root: [u8; 32],
    pub stat_proof: Vec<ProofNode>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SettlementProof {
    /// Score-update timestamp (ms) used to locate the daily roots PDA.
    pub ts: i64,
    pub summary: ScoresBatchSummary,
    pub fixture_proof: Vec<ProofNode>,
    pub main_tree_proof: Vec<ProofNode>,
    pub stat_p1: StatTerm,
    pub stat_p2: StatTerm,
}

// ---- accounts ----

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum MarketState { Open, Proposed, Settled }
impl anchor_lang::Space for MarketState { const INIT_SPACE: usize = 1; }

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub fixture_id: i64,
    pub kickoff_ts: i64,
    pub pools: [u64; 3],
    pub state: MarketState,
    pub proposed_outcome: u8,
    pub proposed_score_ts: i64,
    pub challenge_deadline: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub market: Pubkey,
    pub owner: Pubkey,
    pub outcome: u8,
    pub amount: u64,
    pub claimed: bool,
}

#[derive(Accounts)]
#[instruction(fixture_id: i64)]
pub struct CreateMarket<'info> {
    #[account(
        init, payer = payer, space = 8 + Market::INIT_SPACE,
        seeds = [b"market", fixture_id.to_le_bytes().as_ref()], bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(outcome: u8)]
pub struct Bet<'info> {
    #[account(mut, seeds = [b"market", market.fixture_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        init_if_needed, payer = bettor, space = 8 + Position::INIT_SPACE,
        seeds = [b"position", market.key().as_ref(), bettor.key().as_ref(), &[outcome]], bump
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub bettor: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeSettlement<'info> {
    #[account(mut, seeds = [b"market", market.fixture_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: txoracle daily_scores_roots PDA; ownership checked here, contents
    /// verified by the validate_stat CPI.
    #[account(owner = TXORACLE_ID)]
    pub daily_scores_roots: UncheckedAccount<'info>,
    /// CHECK: the txoracle program itself (CPI target), pinned by address.
    #[account(address = TXORACLE_ID)]
    pub txoracle: UncheckedAccount<'info>,
    pub cranker: Signer<'info>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut, seeds = [b"market", market.fixture_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut, seeds = [b"market", market.fixture_id.to_le_bytes().as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), owner.key().as_ref(), &[position.outcome]],
        bump, has_one = market, has_one = owner
    )]
    pub position: Account<'info, Position>,
    #[account(mut)]
    pub owner: Signer<'info>,
}

#[error_code]
pub enum ErrorCode {
    #[msg("kickoff is in the past")] KickoffInPast,
    #[msg("invalid outcome index")] BadOutcome,
    #[msg("zero amount")] ZeroAmount,
    #[msg("market not open")] MarketNotOpen,
    #[msg("market locked (kickoff passed)")] MarketLocked,
    #[msg("too early to settle")] TooEarly,
    #[msg("proof is for a different fixture")] WrongFixture,
    #[msg("challenge window over")] ChallengeOver,
    #[msg("challenge window still open")] ChallengeOpen,
    #[msg("proof older than current proposal")] StaleProof,
    #[msg("nothing proposed")] NothingProposed,
    #[msg("market not settled")] NotSettled,
    #[msg("already claimed")] AlreadyClaimed,
    #[msg("losing position")] LosingPosition,
    #[msg("wrong stat key")] WrongStat,
    #[msg("arithmetic overflow")] Overflow,
    #[msg("txoracle proof verification failed")] VerificationFailed,
}
