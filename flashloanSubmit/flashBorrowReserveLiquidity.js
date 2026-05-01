"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.layout = exports.DISCRIMINATOR = void 0;
exports.flashBorrowReserveLiquidity = flashBorrowReserveLiquidity;
/* eslint-disable @typescript-eslint/no-unused-vars */
const kit_1 = require("@solana/kit");
const borsh = __importStar(require("@coral-xyz/borsh")); // eslint-disable-line @typescript-eslint/no-unused-vars
const programId_1 = require("@kamino-finance/klend-sdk/dist/@codegen/klend/programId");
exports.DISCRIMINATOR = Buffer.from([135, 231, 52, 167, 7, 52, 212, 193]);
exports.layout = borsh.struct([
    borsh.u64("liquidityAmount"),
]);
function flashBorrowReserveLiquidity(args, accounts, remainingAccounts = [], programAddress = programId_1.PROGRAM_ID) {
    const keys = [
        {
            address: accounts.userTransferAuthority.address,
            role: 2,
            signer: accounts.userTransferAuthority,
        },
        { address: accounts.lendingMarketAuthority, role: 0 },
        { address: accounts.lendingMarket, role: 0 },
        { address: accounts.reserve, role: 1 },
        { address: accounts.reserveLiquidityMint, role: 0 },
        { address: accounts.reserveSourceLiquidity, role: 1 },
        { address: accounts.userDestinationLiquidity, role: 1 },
        { address: accounts.reserveLiquidityFeeReceiver, role: 1 },
        (0, kit_1.isSome)(accounts.referrerTokenState)
            ? { address: accounts.referrerTokenState.value, role: 1 }
            : { address: programAddress, role: 0 },
        (0, kit_1.isSome)(accounts.referrerAccount)
            ? { address: accounts.referrerAccount.value, role: 1 }
            : { address: programAddress, role: 0 },
        { address: accounts.sysvarInfo, role: 0 },
        { address: accounts.tokenProgram, role: 0 },
        ...remainingAccounts,
    ];
    const buffer = Buffer.alloc(1000);
    const len = exports.layout.encode({
        liquidityAmount: args.liquidityAmount,
    }, buffer);
    const data = Buffer.concat([exports.DISCRIMINATOR, buffer]).slice(0, 8 + len);
    const ix = { accounts: keys, programAddress, data };
    return ix;
}
//# sourceMappingURL=flashBorrowReserveLiquidity.js.map
