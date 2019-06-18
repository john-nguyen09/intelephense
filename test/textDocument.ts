import { TextDocument } from '../src/textDocument';
import {Position} from 'vscode-languageserver-types';
import { assert } from 'chai';
import 'mocha';


var src =
`<?php

    $var = 1;

`;

var afterInsert =
`<?php

    $var = 101;

`;

var afterDelete = 
`<?php


`;

var afterReplace = 
`<?php

    $foobar = 1;

`;

var doc = new TextDocument('test', src);

describe('TextDocument', function () {

    describe('lineOffsets', function () {

        it('correct line offsets', function () {
            assert.deepEqual([
                doc.lineSubstring(5),
                doc.lineSubstring(6),
                doc.lineSubstring(20),
                doc.lineSubstring(21),
            ], [
                '<?php',
                '',
                '    $var = 1;',
                ''
            ]);

        });


    });

    describe('positionAtOffset', function(){

        it('correct position ', function(){
            assert.deepEqual(doc.positionAtOffset(12), <Position>{
                line:2,
                character:5
            });
        });

    });

    describe('offsetAtPosition', function(){

        it('correct offset', function(){
            assert.equal(doc.offsetAtPosition({
                line:2,
                character:9
            }), 16);

        });

    });

    describe('applyEdit', function(){

        it('insert', function(){

            var insertDoc = new TextDocument('test', src);
            insertDoc.applyEdit({
                line:2,
                character:11
            }, {
                line:2,
                character:11
            }, '10');
            assert.equal(insertDoc.text, afterInsert);

        });

        it('delete', function(){

            var deleteDoc = new TextDocument('test', src);
            deleteDoc.applyEdit({
                line:2,
                character:0
            }, {
                line:3,
                character:0
            }, '');
            assert.equal(deleteDoc.text, afterDelete);

        });

        it('replace', function(){

            var replaceDoc = new TextDocument('test', src);
            replaceDoc.applyEdit({
                line:2,
                character:5
            }, {
                line:2,
                character:8
            }, 'foobar');
            assert.equal(replaceDoc.text, afterReplace);

        });

    });


});