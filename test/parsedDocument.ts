import { ParsedDocument } from '../src/parsedDocument';
import { assert } from 'chai';
import 'mocha';
import { TokenKind } from 'php7parser';

var firstTokenSrc =
    `<?php
    class MyClass { }
`;

describe('ParsedDocument', function () {

    describe('firstToken', function () {

        it('returns first token of phrase', () => {

            let doc = new ParsedDocument('test', firstTokenSrc);
            let classNode = doc.tree.children[2];
            let tFirst = ParsedDocument.firstToken(classNode);
            let expected = {
                kind: TokenKind.Class as number,
                offset: 10,
                length: 5
            };
            //console.log(JSON.stringify(tFirst, null, 4));
            assert.deepEqual(tFirst, expected);

        })

    });

});