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
exports.updateReserveConfig = updateReserveConfig;
const borsh = __importStar(require("@coral-xyz/borsh")); // eslint-disable-line @typescript-eslint/no-unused-vars
const types = __importStar(require("@kamino-finance/klend-sdk/dist/@codegen/klend/types")); // eslint-disable-line @typescript-eslint/no-unused-vars
const programId_1 = require("@kamino-finance/klend-sdk/dist/@codegen/klend/programId");
exports.DISCRIMINATOR = Buffer.from([61, 148, 100, 70, 143, 107, 17, 13]);
exports.layout = borsh.struct([
    types.UpdateConfigMode.layout("mode"),
    borsh.vecU8("value"),
    borsh.bool("skipConfigIntegrityValidation"),
]);
function updateReserveConfig(args, accounts, remainingAccounts = [], programAddress = programId_1.PROGRAM_ID) {
    const keys = [
        { address: accounts.signer.address, role: 2, signer: accounts.signer },
        { address: accounts.globalConfig, role: 0 },
        { address: accounts.lendingMarket, role: 0 },
        { address: accounts.reserve, role: 1 },
        ...remainingAccounts,
    ];
    const buffer = Buffer.alloc(1000);
    const len = exports.layout.encode({
        mode: args.mode.toEncodable(),
        value: Buffer.from(args.value.buffer, args.value.byteOffset, args.value.length),
        skipConfigIntegrityValidation: args.skipConfigIntegrityValidation,
    }, buffer);
    const data = Buffer.concat([exports.DISCRIMINATOR, buffer]).slice(0, 8 + len);
    const ix = { accounts: keys, programAddress, data };
    return ix;
}
//# sourceMappingURL=updateReserveConfig.js.map
