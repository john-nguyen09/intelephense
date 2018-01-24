/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const symbol_1 = require("./symbol");
class HoverProvider {
    constructor(docStore, symbolStore, refStore) {
        this.docStore = docStore;
        this.symbolStore = symbolStore;
        this.refStore = refStore;
    }
    provideHover(uri, pos) {
        let doc = this.docStore.find(uri);
        let table = this.refStore.getReferenceTable(uri);
        if (!doc || !table) {
            return undefined;
        }
        let ref = table.referenceAtPosition(pos);
        if (!ref) {
            return undefined;
        }
        let symbol = this.symbolStore.findSymbolsByReference(ref, 1 /* Override */).shift();
        if (!symbol) {
            return undefined;
        }
        switch (symbol.kind) {
            case 64 /* Function */:
            case 32 /* Method */:
                let symbolDeclaration = '<?php\n' + [
                    this.modifiersToString(symbol.modifiers),
                    symbol.name + symbol_1.PhpSymbol.signatureString(symbol),
                ].join(' ').trim();
                let hoverTexts = [];
                hoverTexts.push({ language: 'php', value: symbolDeclaration });
                if (symbol.doc && symbol.doc.description) {
                    hoverTexts.push(symbol.doc.description);
                }
                return {
                    contents: hoverTexts,
                    range: ref.location.range
                };
            case 128 /* Parameter */:
                return {
                    contents: [symbol_1.PhpSymbol.type(symbol) || 'mixed', symbol.name].join(' ').trim(),
                    range: ref.location.range
                };
            case 16 /* Property */:
                return {
                    contents: [this.modifiersToString(symbol.modifiers), symbol_1.PhpSymbol.type(symbol) || 'mixed', symbol.name].join(' ').trim(),
                    range: ref.location.range
                };
            case 256 /* Variable */:
                return {
                    contents: [ref.type, symbol.name].join(' ').trim(),
                    range: ref.location.range
                };
            case 8 /* Constant */:
            case 1024 /* ClassConstant */:
                return {
                    contents: [this.modifiersToString(symbol.modifiers), 'const', symbol.name, symbol.value ? `= ${symbol.value}` : ''].join(' ').trim(),
                    range: ref.location.range
                };
            default:
                return undefined;
        }
    }
    modifiersToString(modifiers) {
        let modStrings = [];
        if (modifiers & 1 /* Public */) {
            modStrings.push('public');
        }
        if (modifiers & 2 /* Protected */) {
            modStrings.push('protected');
        }
        if (modifiers & 4 /* Private */) {
            modStrings.push('private');
        }
        if (modifiers & 8 /* Final */) {
            modStrings.push('final');
        }
        if (modifiers & 16 /* Abstract */) {
            modStrings.push('abstract');
        }
        return modStrings.join(' ');
    }
}
exports.HoverProvider = HoverProvider;
