import { BinarySearch } from '../src/types';
import { assert } from 'chai';
import 'mocha';
import { ParsedDocument, ParsedDocumentStore } from '../src/parsedDocument';
import { SymbolStore, SymbolTable } from '../src/symbolStore';
import { NameTextEditProvider } from '../src/commands';
import {ReferenceReader} from '../src/referenceReader';
import {ReferenceStore, ReferenceTable} from '../src/reference';
import {MemoryCache} from '../src/cache';
import LevelConstructor from 'levelup';
import MemDown from 'memdown';

async function setup(srcArray:string[]) {
    const level = LevelConstructor(MemDown());
    let docStore = new ParsedDocumentStore();
    let refStore = new ReferenceStore();
    let symbolStore = new SymbolStore(level);

    let doc:ParsedDocument;
    let src:string;
    let symbolTable:SymbolTable;
    let refTable:ReferenceTable;

    for(let n = 0; n < srcArray.length; ++n) {
        src = srcArray[n];
        doc = new ParsedDocument('doc' + n, src);
        docStore.add(doc);
        symbolTable = SymbolTable.create(doc);
        symbolStore.add(symbolTable);
    }

    for(let n = 0; n < srcArray.length; ++n) {
        refTable = await ReferenceReader.discoverReferences(docStore.find('doc' + n), symbolStore);
        refStore.add(refTable);
    }

    return new NameTextEditProvider(symbolStore, docStore, refStore);

}

let dontEditUseDecl1 = `
<?php
namespace Foo;
class Bar {}
`;

let dontEditUseDecl2 = 
`<?php
use Foo\\Bar;
$bar = new \\Foo\\Bar;
`;


describe('importSymbol', async () => {

    let src1 =
        `<?php
        namespace Foo;
        class Bar {}
    `;

    let src2 =
        `<?php
        namespace Baz;
        $var = new \\Foo\\Bar;
    `;

    let doc1 = new ParsedDocument('doc1', src1);
    let doc2 = new ParsedDocument('doc2', src2);
    let docStore = new ParsedDocumentStore();
    let refStore = new ReferenceStore();
    docStore.add(doc1);
    docStore.add(doc2);
    const level = LevelConstructor(MemDown());
    let symbolStore = new SymbolStore(level);
    let t1 = SymbolTable.create(doc1);
    let t2 = SymbolTable.create(doc2);
    symbolStore.add(t1);
    symbolStore.add(t2);
    let refTable = await ReferenceReader.discoverReferences(doc1, symbolStore);
    let refTable2 = await ReferenceReader.discoverReferences(doc2, symbolStore);
    refStore.add(refTable);
    refStore.add(refTable2);

    let expected = [
        {
            range: {
                start: {
                    line: 2,
                    character: 19
                },
                end: {
                    line: 2,
                    character: 27
                }
            },
            newText: "Bar"
        },
        {
            range: {
                start: {
                    line: 1,
                    character: 22
                },
                end: {
                    line: 1,
                    character: 22
                }
            },
            newText: "\n\n        use Foo\\Bar;\n"
        }
    ];


    it('Should return text edits when a symbol can be imported', async () => {

        let provider = new NameTextEditProvider(symbolStore, docStore, refStore);
        let edits = await provider.provideContractFqnTextEdits('doc2', { line: 2, character: 27 });
        //console.log(JSON.stringify(edits, null, 4));
        assert.deepEqual(edits, expected);
    });

    it('should not replace use decl reference', async () => {

        let expected = [
            {
                "range": {
                    "start": {
                        "line": 2,
                        "character": 11
                    },
                    "end": {
                        "line": 2,
                        "character": 19
                    }
                },
                "newText": "Bar"
            }
        ];

        let provider = await setup([dontEditUseDecl1, dontEditUseDecl2]);
        let edits = await provider.provideContractFqnTextEdits('doc1', {line:2, character:16});
        //console.log(JSON.stringify(edits, null, 4));
        assert.deepEqual(edits, expected);

    });

});