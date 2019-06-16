import { DefinitionProvider } from '../src/definitionProvider';
import { SymbolStore, SymbolTable } from '../src/symbolStore';
import { ParsedDocumentStore, ParsedDocument } from '../src/parsedDocument';
import { ReferenceReader } from '../src/referenceReader';
import { ReferenceStore } from '../src/reference';
import * as lsp from 'vscode-languageserver-types';
import { assert } from 'chai';
import 'mocha';
import LevelConstructor from 'levelup';
import MemDown from 'memdown';


async function setup(src: string) {
    const level = LevelConstructor(MemDown());
    let docStore = new ParsedDocumentStore();
    let doc = new ParsedDocument('test', src);
    let symbolStore = new SymbolStore(level, docStore);
    let table = SymbolTable.create(doc);
    let refStore = new ReferenceStore();
    docStore.add(doc);
    await symbolStore.add(table);
    let refTable = await ReferenceReader.discoverReferences(doc, symbolStore);
    refStore.add(refTable);

    return new DefinitionProvider(symbolStore, docStore, refStore);

}

let objectAccessSrc =
    `<?php
    class Test {
        public $foo;
        function bar(){}
    }
    $var = new Test();
    $var->bar();
    $var->foo;
`;

let scopedAccessSrc =
    `<?php
    class Test {
        const FOO = 1;
        static public $bar;
        static function baz(){}
    }
    Test::FOO;
    Test::$bar;
    Test::baz();
`;

let nameSrc =
    `<?php
    namespace Foo;
    function fn(){}
    fn();
`;

let defineSrc =
    `<?php
define('FOO', 'Bar');
echo FOO;
`;

let constSrc =
    `<?php
const FOO = 'Bar';
echo FOO;
`;

let unprefixedSrc =
    `<?php
function foo() { }
namespace Bar;
foo();
`;

describe('DefintionProvider', function () {

    describe('#provideDefinition', function () {

        describe('Object access expr', function () {

            let provider: DefinitionProvider
            before(async function () {
                provider = await setup(objectAccessSrc);
            });

            it('method location', async function () {
                let loc = await provider.provideDefinition('test', { line: 6, character: 12 });
                let expected: lsp.Location = {
                    uri: 'test',
                    range: {
                        start: { line: 3, character: 8 },
                        end: { line: 3, character: 24 }
                    }
                }
                assert.deepEqual(loc, expected);
                //console.log(JSON.stringify(loc, null, 4));
            });

            it('property location', async function () {
                let loc = await provider.provideDefinition('test', { line: 7, character: 12 });
                let expected: lsp.Location = {
                    uri: 'test',
                    range: {
                        start: { line: 2, character: 15 },
                        end: { line: 2, character: 19 }
                    }
                }
                assert.deepEqual(loc, expected);
                //console.log(JSON.stringify(loc, null, 4));
            });

        });

        describe('Scoped access expr', function () {

            let provider: DefinitionProvider
            before(async function () {
                provider = await setup(scopedAccessSrc);
            });

            it('method location', async function () {
                let loc = await provider.provideDefinition('test', { line: 8, character: 12 });
                let expected: lsp.Location = {
                    uri: 'test',
                    range: {
                        start: { line: 4, character: 8 },
                        end: { line: 4, character: 31 }
                    }
                }
                assert.deepEqual(loc, expected);
                //console.log(JSON.stringify(loc, null, 4));
            });

            it('property location', async function () {
                let loc = await provider.provideDefinition('test', { line: 7, character: 12 });
                let expected: lsp.Location = {
                    uri: 'test',
                    range: {
                        start: { line: 3, character: 22 },
                        end: { line: 3, character: 26 }
                    }
                }
                assert.deepEqual(loc, expected);
                //console.log(JSON.stringify(loc, null, 4));
            });

            it('const location', async function () {
                let loc = await provider.provideDefinition('test', { line: 6, character: 12 });
                let expected: lsp.Location = {
                    uri: 'test',
                    range: {
                        start: { line: 2, character: 14 },
                        end: { line: 2, character: 21 }
                    }
                }
                assert.deepEqual(loc, expected);
                //console.log(JSON.stringify(loc, null, 4));
            });

        });

        describe('Name', function () {

            let provider: DefinitionProvider;
            before(async function () {
                provider = await setup(nameSrc);
            });

            it('function', async function () {
                let loc = await provider.provideDefinition('test', { line: 3, character: 5 });
                let expected: lsp.Location = {
                    uri: 'test',
                    range: {
                        start: { line: 2, character: 4 },
                        end: { line: 2, character: 19 }
                    }
                }
                assert.deepEqual(loc, expected);
                //console.log(JSON.stringify(loc, null, 4));
            });

        });

        it('defines', async function () {
            let provider = await setup(defineSrc);
            let loc = await provider.provideDefinition('test', { line: 2, character: 8 });
            let expected: lsp.Location = {
                uri: 'test',
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 20 }
                }
            }
            //console.log(JSON.stringify(loc, null, 4));
            assert.deepEqual(loc, expected);
        });

        it('multiple locations', async () => {
            const level = LevelConstructor(MemDown());
            let docStore = new ParsedDocumentStore();
            let symbolStore = new SymbolStore(level, docStore);
            let doc = new ParsedDocument('test', defineSrc);
            let doc2 = new ParsedDocument('test2', constSrc);
            let table = SymbolTable.create(doc);
            let table2 = SymbolTable.create(doc2);
            let refStore = new ReferenceStore();
            docStore.add(doc);
            docStore.add(doc2);
            await symbolStore.add(table);
            await symbolStore.add(table2);
            let refTable1 = await ReferenceReader.discoverReferences(doc, symbolStore);
            refStore.add(refTable1);
            let refTable2 = await ReferenceReader.discoverReferences(doc2, symbolStore);
            refStore.add(refTable2);

            let provider = new DefinitionProvider(symbolStore, docStore, refStore);
            let locs = await provider.provideDefinition('test2', { line: 2, character: 8 });
            let expected: lsp.Location[] = [
                {
                    uri: "test",
                    range: {
                        start: {
                            line: 1,
                            character: 0
                        },
                        end: {
                            line: 1,
                            character: 20
                        }
                    }
                },
                {
                    uri: "test2",
                    range: {
                        start: {
                            line: 1,
                            character: 6
                        },
                        end: {
                            line: 1,
                            character: 17
                        }
                    }
                }
            ]
            //console.log(JSON.stringify(locs, null, 4));
            assert.deepEqual(locs, expected);

        });

        it('unprefixed global function', async function () {
            let provider = await setup(unprefixedSrc);
            let loc = await provider.provideDefinition('test', { line: 3, character: 2 });
            let expected: lsp.Location = {
                uri: 'test',
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 18 }
                }
            }
            //console.log(JSON.stringify(loc, null, 4));
            assert.deepEqual(loc, expected);
        });

    });



});