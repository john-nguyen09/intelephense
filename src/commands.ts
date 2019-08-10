/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import {Position, TextEdit} from 'vscode-languageserver-types';
import { ParsedDocument, ParsedDocumentStore } from './parsedDocument';
import { ParseTreeTraverser } from './parseTreeTraverser';
import { SymbolStore, SymbolTable } from './symbolStore';
import { SymbolKind, PhpSymbol } from './symbol';
import { Reference, ReferenceStore, ReferenceTable} from './reference';
import {UseDeclarationHelper} from './useDeclarationHelper';
import * as util from './utils';

export class NameTextEditProvider {

    constructor(public symbolStore:SymbolStore, public docStore:ParsedDocumentStore, public refStore:ReferenceStore) {

    }

    async provideContractFqnTextEdits(uri:string, position:Position, alias?:string) {

        const kindMask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.Function | SymbolKind.Constant | SymbolKind.Constructor;
        let edits:TextEdit[] = [];
        let doc = this.docStore.find(uri);
        let table = await this.symbolStore.getSymbolTable(uri);
        let refTable = this.refStore.getReferenceTable(uri);
        if(!doc || !table || !refTable) {
            return edits;
        }

        let ref = refTable.referenceAtPosition(position);
        
        if(!ref || !(ref.kind & kindMask)) {
            return edits;
        }

        let helper = new UseDeclarationHelper(doc, table, position);
        let fqnUseSymbol = helper.findUseSymbolByFqn(ref.name);
        let nameUseSymbol = helper.findUseSymbolByName(PhpSymbol.notFqn(ref.name));

        if (!fqnUseSymbol){
            if(!alias && nameUseSymbol) {
                //declaration will clash with an existing import
                return edits;
            }

            edits.push(helper.insertDeclarationTextEdit(ref, alias));

        } else if(alias && fqnUseSymbol.name !== alias) {
            //replace existing 
            const replaceTextEdit = helper.replaceDeclarationTextEdit(ref, alias);

            if (replaceTextEdit) {
                edits.push(replaceTextEdit);
            }
        }

        let name = alias || PhpSymbol.notFqn(ref.name);
        
        let lcName = ref.name.toLowerCase();

        let fn = (r:Reference) => {
            return (r.kind & kindMask) > 0 && 
                lcName === r.name.toLowerCase() && 
                ((!fqnUseSymbol || !fqnUseSymbol.location) || 
                    (util.isInRange(r.location.range.start, fqnUseSymbol.location.range) !== 0 &&
                    util.isInRange(r.location.range.end, fqnUseSymbol.location.range) !== 0));
        };

        let references = refTable.references(fn);

        for (let n = 0, l = references.length; n < l; ++n) {
            edits.push(TextEdit.replace(references[n].location.range, name));
        }
    
        return edits.reverse();

    }

}
