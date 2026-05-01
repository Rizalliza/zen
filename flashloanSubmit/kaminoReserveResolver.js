'use strict';
/**
 * kaminoReserveResolver.js
 *
 * Resolves Kamino lending reserve accounts for flashloan borrow/repay.
 *
 * Provides:
 *   - extractReserveSnapshot(raw)          → canonical reserve shape
 *   - buildFlashloanAccountsFromReserveDetail(raw, opts) → { borrowAccounts, repayAccounts }
 *
 * This is a production scaffold. In live use, replace with Kamino API calls
 * or on-chain account resolution against your target lending market.
 */

const { PublicKey } = require('@solana/web3.js');

/* -------------------------------------------------------------------------- */
/*                             Reserve snapshot                               */
/* -------------------------------------------------------------------------- */

function extractReserveSnapshot(raw = {}) {
  // Accept either flat or nested reserve detail formats
  const reserve = raw.reserve && typeof raw.reserve === 'object' ? raw.reserve : raw;

  const lendingMarket = reserve.lendingMarket || reserve.lendingMarketAddress || reserve.market || null;
  const reserveAddress = reserve.address || reserve.reserve || reserve.reserveAddress || null;
  const reserveLiquidityMint = reserve.reserveLiquidityMint || reserve.liquidityMint || reserve.mint || null;
  const reserveLiquiditySupply = reserve.reserveLiquiditySupply || reserve.liquiditySupply || reserve.sourceLiquidity || null;
  const reserveLiquidityFeeReceiver = reserve.reserveLiquidityFeeReceiver || reserve.feeReceiver || null;

  if (!lendingMarket || !reserveAddress || !reserveLiquidityMint) {
    throw new Error(
      'Invalid reserve detail format. Expected fields: lendingMarket, reserve/reserveAddress, reserveLiquidityMint.\n' +
      'Got keys: ' + Object.keys(reserve).join(', ')
    );
  }

  return {
    lendingMarket,
    reserveAddress,
    reserveLiquidityMint,
    reserveLiquiditySupply,
    reserveLiquidityFeeReceiver,
    // Passthrough any additional fields
    ...reserve,
  };
}

/* -------------------------------------------------------------------------- */
/*                        Account derivation helpers                          */
/* -------------------------------------------------------------------------- */

function pubkeyOrNull(v) {
  if (!v) return null;
  if (v instanceof PublicKey) return v;
  try {
    return new PublicKey(v);
  } catch (_e) {
    return null;
  }
}

function toPubkeyString(v) {
  if (!v) return '';
  if (v instanceof PublicKey) return v.toBase58();
  return String(v);
}

function requirePubkeyString(value, label) {
  const pubkey = pubkeyOrNull(value);
  if (!pubkey) {
    throw new Error(`${label} must be a valid public key. Got: ${String(value || '')}`);
  }
  return pubkey.toBase58();
}

/**
 * Derive the lending market authority PDA.
 * Kamino uses: ["lma", lending_market] seeds.
 */
function deriveLendingMarketAuthority(lendingMarket) {
  const lm = pubkeyOrNull(lendingMarket);
  if (!lm) return null;
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('lma'), lm.toBuffer()],
      new PublicKey('KLend2g3cP87fffoSw8b1zWzGvNfRj6Q2uHvXN4e8fQ')
    );
    return pda.toBase58();
  } catch (_e) {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                    Flashloan accounts from reserve detail                  */
/* -------------------------------------------------------------------------- */

function buildFlashloanAccountsFromReserveDetail(raw = {}, opts = {}) {
  const snapshot = extractReserveSnapshot(raw);

  const lendingMarket = requirePubkeyString(snapshot.lendingMarket, 'lendingMarket');
  const reserve = requirePubkeyString(snapshot.reserveAddress, 'reserve');
  const reserveLiquidityMint = requirePubkeyString(snapshot.reserveLiquidityMint, 'reserveLiquidityMint');
  const reserveLiquidityFeeReceiver = requirePubkeyString(
    snapshot.reserveLiquidityFeeReceiver,
    'reserveLiquidityFeeReceiver'
  );

  // Derive or use provided lendingMarketAuthority
  let lendingMarketAuthority = opts.lendingMarketAuthority || deriveLendingMarketAuthority(lendingMarket);
  if (!lendingMarketAuthority) {
    throw new Error(
      'Unable to derive lendingMarketAuthority.\n' +
      '  Provide it in opts.lendingMarketAuthority, or ensure lendingMarket is a valid Kamino market pubkey.\n' +
      '  lendingMarket received: ' + String(lendingMarket)
    );
  }

  // Source liquidity = reserve's liquidity supply vault
  const reserveSourceLiquidityRaw = opts.reserveSourceLiquidity || snapshot.reserveLiquiditySupply;
  if (!reserveSourceLiquidityRaw) {
    throw new Error('reserveSourceLiquidity is required (reserve liquidity supply vault). Got: ' + String(snapshot.reserveLiquiditySupply));
  }
  const reserveSourceLiquidity = requirePubkeyString(reserveSourceLiquidityRaw, 'reserveSourceLiquidity');

  // Destination liquidity = user's ATA for the borrowed token
  const userLiquidityAccount = opts.userLiquidityAccount || opts.userDestinationLiquidity || null;
  if (!userLiquidityAccount) {
    throw new Error(
      'userLiquidityAccount is required. Pass the payer\'s ATA for the borrowed token.\n' +
      '  Derive it with:\n' +
      '    const { getAssociatedTokenAddressSync } = require(\'@solana/spl-token\');\n' +
      '    const ata = getAssociatedTokenAddressSync(new PublicKey(reserveLiquidityMint), payerPublicKey);'
    );
  }
  const normalizedUserLiquidityAccount = requirePubkeyString(userLiquidityAccount, 'userLiquidityAccount');

  // For repay, destination = same supply vault, source = user's ATA
  const reserveDestinationLiquidity = reserveSourceLiquidity;
  const userSourceLiquidity = normalizedUserLiquidityAccount;

  const borrowAccounts = {
    lendingMarketAuthority,
    lendingMarket,
    reserve,
    reserveLiquidityMint,
    reserveSourceLiquidity,
    userDestinationLiquidity: normalizedUserLiquidityAccount,
    reserveLiquidityFeeReceiver,
  };

  const repayAccounts = {
    lendingMarketAuthority,
    lendingMarket,
    reserve,
    reserveLiquidityMint,
    reserveDestinationLiquidity,
    userSourceLiquidity,
    reserveLiquidityFeeReceiver,
  };

  return {
    borrowAccounts,
    repayAccounts,
    lendingMarketAuthority,
    userLiquidityAccount: normalizedUserLiquidityAccount,
  };
}

/* -------------------------------------------------------------------------- */
/*                             MODULE EXPORTS                                 */
/* -------------------------------------------------------------------------- */

module.exports = {
  extractReserveSnapshot,
  buildFlashloanAccountsFromReserveDetail,
  deriveLendingMarketAuthority,
  pubkeyOrNull,
  toPubkeyString,
  requirePubkeyString,
};
//. node flashloanSubmit/kaminoReserveResolver.js
