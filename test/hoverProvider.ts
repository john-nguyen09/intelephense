import { HoverProvider } from '../src/hoverProvider';
import { SymbolKind } from '../src/symbol';
import { SymbolStore, SymbolTable } from '../src/symbolStore';
import { ParsedDocumentStore, ParsedDocument } from '../src/parsedDocument';
import * as lsp from 'vscode-languageserver-types';
import { assert } from 'chai';
import { ReferenceReader } from '../src/referenceReader';
import { ReferenceStore } from '../src/reference';
import { MemoryCache } from '../src/cache';
import 'mocha';

function setup(src: string) {
    let docStore = new ParsedDocumentStore();
    let symbolStore = new SymbolStore();
    let doc = new ParsedDocument('test', src);
    let refStore = new ReferenceStore(new MemoryCache());
    docStore.add(doc);
    let table = SymbolTable.create(doc);
    symbolStore.add(table);
    let refTable = ReferenceReader.discoverReferences(doc, symbolStore);
    refStore.add(refTable);
    //console.log(JSON.stringify(table.find((x)=>{return x.name === 'bar'}), null, 4));
    return new HoverProvider(docStore, symbolStore, refStore);
}

let fnAssignmentSrc =
    `<?php
class Foo {
    function bar():int{}
}
function factory():Foo;
$var = factory();
$var = $var->bar();
`;

describe('hover provider', () => {

    it('vars', () => {

        let expected = {
            "contents": "Foo $var",
            "range": {
                "start": {
                    "line": 6,
                    "character": 7
                },
                "end": {
                    "line": 6,
                    "character": 11
                }
            }
        };
        let provider = setup(fnAssignmentSrc);
        let hover = provider.provideHover('test', <lsp.Position>{ line: 6, character: 10 });

        //console.log(JSON.stringify(hover, null, 4));
        assert.deepEqual(hover, expected);
    });


});