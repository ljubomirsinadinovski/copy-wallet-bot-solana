import { SWAP_PROGRAMS } from '../solana/constants.js';

export const SWAP_INSTRUCTION = /Instruction: \w*(Buy|Sell|Swap|Route)\w*/i;

/** Liquidity-pool, staking and locking actions: tokens move but nothing is bought or sold. */
export const LIQUIDITY_INSTRUCTION =
  /Instruction: \w*(Deposit|Withdraw|AddLiquidity|RemoveLiquidity|IncreaseLiquidity|DecreaseLiquidity|OpenPosition|ClosePosition|CreatePool|InitializePool|Stake|Unstake|Lock|Unlock)\w*/i;

/**
 * Cheap check on a transaction's logs: does it look like a trade? Used on the free tier to avoid
 * spending an RPC lookup on spam, dust and plain transfers.
 */
export function looksLikeSwap(logs: string[]): boolean {
  for (const line of logs) {
    if (line.startsWith('Program ') && line.includes(' invoke [')) {
      const programId = line.split(' ')[1];
      if (SWAP_PROGRAMS[programId]) return true;
    }
    if (SWAP_INSTRUCTION.test(line)) return true;
    if (line.includes('Log truncated')) return true;
  }
  return false;
}

/** Transfers must reach the parser so tokens leaving a watched wallet can trigger an exit. */
export function looksLikeTradeOrTransfer(logs: string[]): boolean {
  return looksLikeSwap(logs) || logs.some((line) => /Instruction: Transfer(?:Checked)?(?:WithFee)?\b/i.test(line));
}
