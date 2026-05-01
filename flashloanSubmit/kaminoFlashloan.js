'use strict';

const {
  PublicKey,
  TransactionInstruction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID } = require('@solana/spl-token');

const KAMINO_LENDING_PROGRAM_ID = new PublicKey('KLend2g3cP87fffoSw8b1zWzGvNfRj6Q2uHvXN4e8fQ');

const FLASH_BORROW_DISCRIMINATOR = Buffer.from([135, 231, 52, 167, 7, 52, 212, 193]);
const FLASH_REPAY_DISCRIMINATOR = Buffer.from([185, 117, 0, 203, 96, 245, 180, 186]);

function pubkeyOf(value, label = 'pubkey') {
  if (value instanceof PublicKey) return value;
  if (value?.publicKey instanceof PublicKey) return value.publicKey;
  if (value?.address instanceof PublicKey) return value.address;
  if (typeof value?.address === 'string') return new PublicKey(value.address);
  if (typeof value === 'string') return new PublicKey(value);
  throw new Error(`${label} is required and must be a PublicKey/string/Keypair-like object`);
}

function optionalPubkey(value) {
  if (!value) return KAMINO_LENDING_PROGRAM_ID;
  if (value?.value) return pubkeyOf(value.value);
  return pubkeyOf(value);
}

function u64Buffer(value, label) {
  const out = Buffer.alloc(8);
  const bigint = BigInt(String(value));
  if (bigint < 0n || bigint > 0xffffffffffffffffn) {
    throw new Error(`${label} must fit in u64. Got: ${String(value)}`);
  }
  out.writeBigUInt64LE(bigint);
  return out;
}

function buildFlashBorrowData(liquidityAmount) {
  return Buffer.concat([
    FLASH_BORROW_DISCRIMINATOR,
    u64Buffer(liquidityAmount, 'liquidityAmount'),
  ]);
}

function buildFlashRepayData(liquidityAmount, borrowInstructionIndex) {
  const index = Number(borrowInstructionIndex);
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    throw new Error(`borrowInstructionIndex must fit in u8. Got: ${String(borrowInstructionIndex)}`);
  }
  return Buffer.concat([
    FLASH_REPAY_DISCRIMINATOR,
    u64Buffer(liquidityAmount, 'liquidityAmount'),
    Buffer.from([index]),
  ]);
}

function buildKaminoFlashBorrowInstruction(accounts = {}) {
  const programId = pubkeyOf(accounts.programId || accounts.programAddress || KAMINO_LENDING_PROGRAM_ID, 'programId');
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: pubkeyOf(accounts.userTransferAuthority, 'userTransferAuthority'), isSigner: true, isWritable: false },
      { pubkey: pubkeyOf(accounts.lendingMarketAuthority, 'lendingMarketAuthority'), isSigner: false, isWritable: false },
      { pubkey: pubkeyOf(accounts.lendingMarket, 'lendingMarket'), isSigner: false, isWritable: false },
      { pubkey: pubkeyOf(accounts.reserve, 'reserve'), isSigner: false, isWritable: true },
      { pubkey: pubkeyOf(accounts.reserveLiquidityMint, 'reserveLiquidityMint'), isSigner: false, isWritable: false },
      { pubkey: pubkeyOf(accounts.reserveSourceLiquidity, 'reserveSourceLiquidity'), isSigner: false, isWritable: true },
      { pubkey: pubkeyOf(accounts.userDestinationLiquidity, 'userDestinationLiquidity'), isSigner: false, isWritable: true },
      { pubkey: pubkeyOf(accounts.reserveLiquidityFeeReceiver, 'reserveLiquidityFeeReceiver'), isSigner: false, isWritable: true },
      { pubkey: optionalPubkey(accounts.referrerTokenState), isSigner: false, isWritable: Boolean(accounts.referrerTokenState) },
      { pubkey: optionalPubkey(accounts.referrerAccount), isSigner: false, isWritable: Boolean(accounts.referrerAccount) },
      { pubkey: pubkeyOf(accounts.sysvarInfo || SYSVAR_INSTRUCTIONS_PUBKEY, 'sysvarInfo'), isSigner: false, isWritable: false },
      { pubkey: pubkeyOf(accounts.tokenProgram || TOKEN_PROGRAM_ID, 'tokenProgram'), isSigner: false, isWritable: false },
    ],
    data: buildFlashBorrowData(accounts.liquidityAmount),
  });
}

function buildKaminoFlashRepayInstruction(accounts = {}) {
  const programId = pubkeyOf(accounts.programId || accounts.programAddress || KAMINO_LENDING_PROGRAM_ID, 'programId');
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: pubkeyOf(accounts.userTransferAuthority, 'userTransferAuthority'), isSigner: true, isWritable: false },
      { pubkey: pubkeyOf(accounts.lendingMarketAuthority, 'lendingMarketAuthority'), isSigner: false, isWritable: false },
      { pubkey: pubkeyOf(accounts.lendingMarket, 'lendingMarket'), isSigner: false, isWritable: false },
      { pubkey: pubkeyOf(accounts.reserve, 'reserve'), isSigner: false, isWritable: true },
      { pubkey: pubkeyOf(accounts.reserveLiquidityMint, 'reserveLiquidityMint'), isSigner: false, isWritable: false },
      { pubkey: pubkeyOf(accounts.reserveDestinationLiquidity, 'reserveDestinationLiquidity'), isSigner: false, isWritable: true },
      { pubkey: pubkeyOf(accounts.userSourceLiquidity, 'userSourceLiquidity'), isSigner: false, isWritable: true },
      { pubkey: pubkeyOf(accounts.reserveLiquidityFeeReceiver, 'reserveLiquidityFeeReceiver'), isSigner: false, isWritable: true },
      { pubkey: optionalPubkey(accounts.referrerTokenState), isSigner: false, isWritable: Boolean(accounts.referrerTokenState) },
      { pubkey: optionalPubkey(accounts.referrerAccount), isSigner: false, isWritable: Boolean(accounts.referrerAccount) },
      { pubkey: pubkeyOf(accounts.sysvarInfo || SYSVAR_INSTRUCTIONS_PUBKEY, 'sysvarInfo'), isSigner: false, isWritable: false },
      { pubkey: pubkeyOf(accounts.tokenProgram || TOKEN_PROGRAM_ID, 'tokenProgram'), isSigner: false, isWritable: false },
    ],
    data: buildFlashRepayData(accounts.liquidityAmount, accounts.borrowInstructionIndex),
  });
}

module.exports = {
  KAMINO_LENDING_PROGRAM_ID,
  FLASH_BORROW_DISCRIMINATOR,
  FLASH_REPAY_DISCRIMINATOR,
  buildKaminoFlashBorrowInstruction,
  buildKaminoFlashRepayInstruction,
  buildFlashBorrowData,
  buildFlashRepayData,
  pubkeyOf,
};
