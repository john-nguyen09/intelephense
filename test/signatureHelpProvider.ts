import { SignatureHelpProvider } from '../src/signatureHelpProvider';
import { SymbolKind } from '../src/symbol';
import {SymbolStore, SymbolTable} from '../src/symbolStore';
import { ParsedDocumentStore, ParsedDocument } from '../src/parsedDocument';
import * as lsp from 'vscode-languageserver-types';
import { assert } from 'chai';
import { ReferenceReader } from '../src/referenceReader';
import {ReferenceStore} from '../src/reference';
import {MemoryCache} from '../src/cache';
import 'mocha';


let constructorHelpSrc =
`<?php
    class Foo {
        function __construct($p1, $p2){}
    }
    $var = new Foo()
`;

let functionHelpSrc = 
`<?php
    function fn($p1, $p2){}
    fn()
`;

let functionHelp2Src = 
`<?php
    function fn($p1, $p2){}
    fn($x,)
`;

let methodHelpSrc = 
`<?php
    class Foo {
        function bar($p1, $p2){}
    }
    $var = new Foo();
    $var->bar()
`;

let defaultParamSrc = 
`<?php
    function fn($p1, $p2 = 1){}
    fn($x,)
`;

let helpWithDocsSrc =
`<?php
    /**
     * I'm a function
     * @param int $p1 I'm a param
     */
    function fn($p1){}
    fn()
`;

let helpWithTypeHintSrc = 
`<?php
    function fn(int $p1){}
    fn()
`;

function setup(src: string) {

    let docStore = new ParsedDocumentStore();
    let symbolStore = new SymbolStore();
    let doc = new ParsedDocument('test', src);
    let refStore = new ReferenceStore();
    docStore.add(doc);
    let table = SymbolTable.create(doc);
    symbolStore.add(table);
    let refTable = ReferenceReader.discoverReferences(doc, symbolStore);
    refStore.add(refTable);

    return new SignatureHelpProvider(symbolStore, docStore, refStore);
}


describe('SignatureHelpProvider', function () {

    describe('#provideSignatureHelp', function () {

        it('Constructor help', function () {

            let provider = setup(constructorHelpSrc);
            let help = provider.provideSignatureHelp('test', {line: 4, character:19});
            let expected:lsp.SignatureHelp = {
                activeParameter:0,
                activeSignature:0,
                signatures:[
                    {
                        label:'__construct($p1, $p2)',
                        parameters:[
                            {
                                label:'$p1',
                            },
                            {
                                label:'$p2',
                            }
                        ]
                    }
                ]
            };
            assert.deepEqual(help, expected);
            //console.log(JSON.stringify(help, null, 4)); 

        });

        it('Function help', function () {

            let provider = setup(functionHelpSrc);
            let help = provider.provideSignatureHelp('test', {line: 2, character:7});
            let expected:lsp.SignatureHelp = {
                activeParameter:0,
                activeSignature:0,
                signatures:[
                    {
                        label:'fn($p1, $p2)',
                        parameters:[
                            {
                                label:'$p1',
                            },
                            {
                                label:'$p2',
                            }
                        ]
                    }
                ]
            };
            assert.deepEqual(help, expected);
            //console.log(JSON.stringify(help, null, 4)); 

        });

        it('Function help second param', function () {

            let provider = setup(functionHelp2Src);
            let help = provider.provideSignatureHelp('test', {line: 2, character:10});
            let expected:lsp.SignatureHelp = {
                activeParameter:1,
                activeSignature:0,
                signatures:[
                    {
                        label:'fn($p1, $p2)',
                        parameters:[
                            {
                                label:'$p1',
                            },
                            {
                                label:'$p2',
                            }
                        ]
                    }
                ]
            };
            assert.deepEqual(help, expected);
            //console.log(JSON.stringify(help, null, 4)); 

        });

        it('Method help', function () {

            let provider = setup(methodHelpSrc);
            let help = provider.provideSignatureHelp('test', {line: 5, character:14});
            let expected:lsp.SignatureHelp = {
                activeParameter:0,
                activeSignature:0,
                signatures:[
                    {
                        label:'bar($p1, $p2)',
                        parameters:[
                            {
                                label:'$p1',
                            },
                            {
                                label:'$p2',
                            }
                        ]
                    }
                ]
            };
            assert.deepEqual(help, expected);
            //console.log(JSON.stringify(help, null, 4)); 

        });

        it('Function help default param sig 2', function () {

            let provider = setup(defaultParamSrc);
            let help = provider.provideSignatureHelp('test', {line: 2, character:10});
            assert.equal(help.signatures.length, 1);
            assert.equal(help.signatures[0].label, 'fn($p1, $p2 = 1)');
            assert.equal(help.activeParameter, 1);
            assert.equal(help.activeSignature, 0);

        });

        it('Function help with docs', function () {

            let provider = setup(helpWithDocsSrc);
            let help = provider.provideSignatureHelp('test', {line: 6, character:7});
            //console.log(JSON.stringify(help, null, 4));
            let expected:lsp.SignatureHelp = {
                activeParameter:0,
                activeSignature:0,
                signatures:[
                    {
                        documentation:"I'm a function",
                        label:'fn(int $p1)',
                        parameters:[
                            {
                                label:'int $p1',
                                documentation:"I'm a param"
                            }
                        ]
                    }
                ]
            };
            assert.deepEqual(help, expected);

        });

        it('Function help with type hint', function () {

            let provider = setup(helpWithTypeHintSrc);
            let help = provider.provideSignatureHelp('test', {line: 2, character:7});
            //console.log(JSON.stringify(help, null, 4));
            let expected:lsp.SignatureHelp = {
                activeParameter:0,
                activeSignature:0,
                signatures:[
                    {
                        label:'fn(int $p1)',
                        parameters:[
                            {
                                label:'int $p1',
                            }
                        ]
                    }
                ]
            };
            assert.deepEqual(help, expected);

        });
       

    });


});