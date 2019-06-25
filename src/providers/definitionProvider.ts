/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { Location, Position } from 'vscode-languageserver-types';
import { PhpSymbol, SymbolKind } from '../symbol';
import { SymbolStore } from '../symbolStore';
import { ParsedDocumentStore } from '../parsedDocument';
import { MemberMergeStrategy } from '../typeAggregate';
import { ReferenceStore, Reference } from '../reference';

export class DefinitionProvider {

    constructor(public symbolStore: SymbolStore, public documentStore: ParsedDocumentStore, public refStore:ReferenceStore) { }

    async provideDefinition(uri: string, position: Position) {

        let doc = this.documentStore.find(uri);
        let table = this.refStore.getReferenceTable(uri);

        if (!doc || !table) {
            return null;
        }

        let ref = table.referenceAtPosition(position);

        if (!ref) {
            return null;
        }

        let symbols = await this.symbolStore.findSymbolsByReference(ref, MemberMergeStrategy.Override);

        if (ref.kind === SymbolKind.Constructor && symbols.length > 0) {
            // Only take constructor of current class for go to definition
            symbols = symbols.filter((symbol) => {
                return symbol.scope === ref.name;
            });
        }

        if(ref.kind === SymbolKind.Constructor && symbols.length < 1) {
            //fallback to class
            symbols = await this.symbolStore.findSymbolsByReference(Reference.create(SymbolKind.Class, ref.name, ref.location), MemberMergeStrategy.Override);
        }

        let locations: Location[] = [];
        let s: PhpSymbol;
        let loc: Location;

        for (let n = 0; n < symbols.length; ++n) {
            s = symbols[n];
            if (s.location && (loc = await this.symbolStore.symbolLocation(s))) {
                locations.push(loc);
            }
        }

        return locations.length === 1 ? locations[0] : locations;

    }

}