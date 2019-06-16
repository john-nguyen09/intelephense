import { PhpSymbol, SymbolKind, SymbolModifier } from '../src/symbol';
import { SymbolTable } from '../src/symbolStore';
import { NameResolver } from '../src/nameResolver';
import { SymbolReader } from '../src/symbolReader';
import { ParsedDocument } from '../src/parsedDocument';
import * as util from '../src/util';
import { assert } from 'chai';
import 'mocha';
import * as fs from 'fs';
import * as path from 'path';

function symbolReaderOutput(src: string) {

    let parsedDoc = new ParsedDocument('test', src);
    let sr = new SymbolReader(parsedDoc, new NameResolver());
    parsedDoc.traverse(sr);
    return sr.symbol;

}

describe('SymbolReader', () => {

    it('define', function () {

        let src = `<?php
            define('FOO', 1);
        `;

        let symbols = symbolReaderOutput(src);
        let defineConstant = symbols.children[0];
        assert.equal(defineConstant.name, 'FOO');
        assert.equal(defineConstant.kind, SymbolKind.Constant);

    });

    it('@method tags', function () {
        let src = `<?php
            /**
             * @method int fn(string $p) method description
             */
            class Foo { }`;

        let symbols = symbolReaderOutput(src);
        //console.log(JSON.stringify(symbols, undefined, 4));
        let method = symbols.children[0].children[0];
        let param = method.children[0];

        assert.equal(method.kind, SymbolKind.Method);
        assert.equal(method.modifiers, SymbolModifier.Magic | SymbolModifier.Public);
        assert.equal(method.name, 'fn');
        assert.equal(method.doc.type, 'int');
        assert.equal(param.kind, SymbolKind.Parameter);
        assert.equal(param.name, '$p');
        assert.equal(param.doc.type, 'string');

        //console.log(JSON.stringify(symbols, null, 4));
    });


    it('namespace use parse error', function () {

        let src =
            `<?php
            use
        `;

        assert.doesNotThrow(() => { symbolReaderOutput(src) });

    });

    it('namespace, use, class, trait', function () {

        let src =
            `<?php
            namespace Wat;

            use Foo\\Baz;
            class Bar {
                use Baz;
            }
        `;
        let output = symbolReaderOutput(src);
        //console.log(JSON.stringify(output, null, 4));
        assert.equal(output.children[0].kind, SymbolKind.Namespace);
        assert.equal(output.children[0].name, 'Wat');
        assert.equal(output.children[1].kind, SymbolKind.Class);
        assert.equal(output.children[1].name, 'Baz');
        assert.equal(output.children[2].kind, SymbolKind.Class);
        assert.equal(output.children[2].name, 'Wat\\Bar');
        assert.deepEqual(output.children[2].associated[0], { kind: SymbolKind.Trait, name: 'Foo\\Baz', location:undefined });
    });

    it('Should read simple variables', () => {
        let src = `<?php 
                        $myVar = 1;
                        
                        function myFunction($myParam){}`;
        let output = symbolReaderOutput(src);
        //console.log(JSON.stringify(output, null, 4));
    });

    it('Should assign phpdoc info', () => {

        let src = `
        <?php

            /**
             * Summary.
             * Description.
             * @param int $param description
             * @return string
             */
            function fn($param){}
        `;

        let output = symbolReaderOutput(src);
        //console.log(JSON.stringify(output, null, 4));

    });

    it('anon classes', () => {
        let src = `
        <?php
            $c = new class {};
        `;
        let uri = 'test';
        let output = symbolReaderOutput(src);
        let expect = <PhpSymbol>{
            kind: 1,
            name: "#anon#test#36",
            modifiers: 512,
            location: {
                uri: uri,
                range: {
                    start: {
                        line: 2,
                        character: 21
                    },
                    end: {
                        line: 2,
                        character: 29
                    }
                }
            },
            associated:[],
            children:[]
        };
        assert.deepEqual(output.children[1], expect);
        //console.log(JSON.stringify(output, null, 4));

    });

    it('@global tag', () => {
        let src = fs.readFileSync(path.join(__dirname, '/fixtures/global-variables.php')).toString();
        let symbols = symbolReaderOutput(src);

        let globalSymbol = symbols.children[0];

        assert.deepEqual(globalSymbol, <PhpSymbol>{
            kind: SymbolKind.GlobalVariable,
            name: '$DB',
            location: {
                uri: 'test',
                range: {
                    start: {
                        line: 7,
                        character: 0
                    },
                    end: {
                        line: 7,
                        character: 11
                    }
                }
            },
            type: 'database',
            associated: [],
            children: [],
            doc: {
                description: 'Database connection. Used for all access to the database.',
                type: 'database'
            }
        });
    });
});