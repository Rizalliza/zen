"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DISCRIMINATOR = void 0;
exports.updateLendingMarketOwner = updateLendingMarketOwner;
const programId_1 = require("@kamino-finance/klend-sdk/dist/@codegen/klend/programId");
exports.DISCRIMINATOR = Buffer.from([118, 224, 10, 62, 196, 230, 184, 89]);
function updateLendingMarketOwner(accounts, remainingAccounts = [], programAddress = programId_1.PROGRAM_ID) {
    const keys = [
        {
            address: accounts.lendingMarketOwnerCached.address,
            role: 2,
            signer: accounts.lendingMarketOwnerCached,
        },
        { address: accounts.lendingMarket, role: 1 },
        ...remainingAccounts,
    ];
    const data = exports.DISCRIMINATOR;
    const ix = { accounts: keys, programAddress, data };
    return ix;
}
//# sourceMappingURL=updateLendingMarketOwner.js.map
