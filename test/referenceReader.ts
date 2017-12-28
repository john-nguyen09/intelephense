import { SymbolKind } from '../src/symbol';
import { SymbolStore, SymbolTable } from '../src/symbolStore';
import { ParsedDocumentStore, ParsedDocument } from '../src/parsedDocument';
import * as lsp from 'vscode-languageserver-types';
import { assert } from 'chai';
import { ReferenceReader } from '../src/referenceReader';
import { ReferenceStore, Reference } from '../src/reference';
import { MemoryCache } from '../src/cache';
import 'mocha';
import { SymbolReader } from '../src/symbolReader';
import * as fs from 'fs';
import * as path from 'path';

function readReferences(src:string) {

    let store = new SymbolStore();
    let doc = new ParsedDocument('test', src);
    let table = SymbolTable.create(doc);
    //console.log(JSON.stringify(table, null, 4));
    store.add(table);
    return ReferenceReader.discoverReferences(doc, store);

}

let issue82Src = 
`<?php
class SomeClass
{
    public function someFunction($in)
    {
        function () use ($in) {
            return '';
        };
    }

    public function someOtherFunction()
    {
        //trigger Undefined index: ccn
        return false || true;
    }
}
`;


describe('ReferenceReader', () => {

    it('issue 82', () => {

        let refTable = readReferences(issue82Src);


    });

    it('@global tag', () => {
        let src = fs.readFileSync(path.join(__dirname, '/fixtures/global-variables.php')).toString();
        let refTable = readReferences(src);
        let globalReference = refTable.references()[0];

        assert.deepEqual(globalReference, <Reference>{
            kind: SymbolKind.GlobalVariable,
            location: {
                range: {
                    start: { line: 7, character: 7 },
                    end: { line: 7, character: 10 }
                },
                uri: 'test'
            },
            name: '$DB',
            type: 'database',
        });
    });


});
