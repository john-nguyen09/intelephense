import { FormatProvider } from '../src/formatProvider';
import { SymbolStore, SymbolTable } from '../src/symbolStore';
import { ParsedDocumentStore, ParsedDocument } from '../src/parsedDocument';
import { ReferenceReader } from '../src/referenceReader';
import * as lsp from 'vscode-languageserver-types';
import { assert } from 'chai';
import 'mocha';


function setup(src:string){
    let doc = new ParsedDocument('test', src);
    let docStore = new ParsedDocumentStore();
    docStore.add(doc);

    return new FormatProvider(docStore);
}

let rangeFormatFullDoc = 
`<?php
foreach ($a as $v) {
echo 'HELLO WORLD';
}

`;

let fixExtraLinesSrc = 
`<?php
function fn()
{
    //dont put newlines after this
}

`;

let conditionalCurlySrc =
`<?php
if (true) 
{
}
else 
{
}

`;

let lcKeywords = 
`<?php
$foo = Array();

`;

let removeCloseTagSrc = 
`<?php
$var = 1;
?>
`;

let endWithBlkLineSrc = 
`<?php
$var = 1;`;

let caseColonSrc = 
`<?php
switch ($foo) {
    case 1 :
        echo 'bar';
}

`;

let noFormatInsideTemplateString =
`<?php
$var = "Don't $format $this->var";
$heredoc = <<<EOD
Don't $format $this->var
EOD;

`;

let noSpaceRequireSrc = 
`<?php
require_once('file');

`;

let parenthesisedArgSrc =
`<?php
fn( ($var));

`;

let encapsExprSrc =
`<?php
$var = \${$var};

`;

let memberAccessWithArrayArgSrc = 
`<?php
$objPHPExcel->getActiveSheet()
    ->getStyle('A3:E3')
    ->applyFromArray(
        array(
            'font' => 'bold'
        )
    );

`;

let multilineParamFnOpeningBraceSrc =
`<?php
function fn(
    $p1,
    $p2
)
{

}

`;

let allowNewlinesAfterOpenTagsrc = 
`<?php

echo 'hi';

`;

let strictNotEqual =
`<?php
$a!==$b;

`;

describe('provideDocumentFormattingEdits', ()=>{


    it('no extra newlines for } after comment', ()=>{
        let provider = setup(fixExtraLinesSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        assert.isArray(edits);
        assert.isEmpty(edits);
    });

    it('single space before else', ()=>{
        let provider = setup(conditionalCurlySrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        let expected = [
            {
                range: {
                    start: {
                        line: 4,
                        character: 4
                    },
                    end: {
                        line: 5,
                        character: 0
                    }
                },
                newText: " "
            },
            {
                range: {
                    start: {
                        line: 3,
                        character: 1
                    },
                    end: {
                        line: 4,
                        character: 0
                    }
                },
                newText: " "
            },
            {
                range: {
                    start: {
                        line: 1,
                        character: 9
                    },
                    end: {
                        line: 2,
                        character: 0
                    }
                },
                newText: " "
            }
        ];
        assert.deepEqual(edits, expected);
    });

    it('lowercase keywords', ()=>{
        let provider = setup(lcKeywords);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        let expected = [
            {
                range: {
                    start: {
                        line: 1,
                        character: 7
                    },
                    end: {
                        line: 1,
                        character: 12
                    }
                },
                newText: "array"
            }
        ];
        assert.deepEqual(edits, expected);
    });

    it('remove close tag', ()=>{
        let provider = setup(removeCloseTagSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        let expected = [
            {
                range: {
                    start: {
                        line: 1,
                        character: 9
                    },
                    end: {
                        line: 3,
                        character: 0
                    }
                },
                newText: "\n\n"
            }
        ];
        assert.deepEqual(edits, expected);
    });

    it('end of file blank newline', ()=>{
        let provider = setup(endWithBlkLineSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        let expected = [
            {
                range: {
                    start: {
                        line: 1,
                        character: 9
                    },
                    end: {
                        line: 1,
                        character: 9
                    }
                },
                newText: "\n\n"
            }
        ];
        assert.deepEqual(edits, expected);
    });

    it('case colon no space', ()=>{
        let provider = setup(caseColonSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        let expected = [
            {
                range: {
                    start: {
                        line: 2,
                        character: 10
                    },
                    end: {
                        line: 2,
                        character: 11
                    }
                },
                newText: ""
            }
        ];
        assert.deepEqual(edits, expected);
    });

    it('no format inside template strings', ()=>{
        let provider = setup(noFormatInsideTemplateString);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        assert.isEmpty(edits);
    });

    it('range format entire doc', ()=>{
        let provider = setup(rangeFormatFullDoc);
        let edits = provider.provideDocumentRangeFormattingEdits({uri: 'test'}, lsp.Range.create(0,0,5,0), {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        assert.isNotEmpty(edits);
    });

    it('no space between require and (', ()=>{
        let provider = setup(noSpaceRequireSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        assert.isEmpty(edits);
    });

    it('no space after fn ( when arg is parentheses encaps', ()=>{
        let provider = setup(parenthesisedArgSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        let expected = [
            {
                "range": {
                    "start": {
                        "line": 1,
                        "character": 3
                    },
                    "end": {
                        "line": 1,
                        "character": 4
                    }
                },
                "newText": ""
            }
        ];
        //console.log(JSON.stringify(edits, null, 4));
        assert.deepEqual(edits, expected);
    });

    it('encaps expr', ()=>{
        let provider = setup(encapsExprSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        assert.isEmpty(edits);
    });

    it('member access with array args', ()=>{
        let provider = setup(memberAccessWithArrayArgSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        assert.isEmpty(edits);
    });

    it('multi line param fn opening brace', ()=>{
        let provider = setup(multilineParamFnOpeningBraceSrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        let expected = [
            {
                "range": {
                    "start": {
                        "line": 4,
                        "character": 1
                    },
                    "end": {
                        "line": 5,
                        "character": 0
                    }
                },
                "newText": " "
            }
        ];
        //console.log(JSON.stringify(edits, null, 4));
        assert.deepEqual(edits, expected);
    });

    it('allow newlines after open tag', ()=>{
        let provider = setup(allowNewlinesAfterOpenTagsrc);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        //console.log(JSON.stringify(edits, null, 4));
        assert.isEmpty(edits);
    });

    it('!== bug', ()=>{
        let provider = setup(strictNotEqual);
        let edits = provider.provideDocumentFormattingEdits({uri: 'test'}, {tabSize:4, insertSpaces:true});
        
        let expected = [
            {
                "range": {
                    "start": {
                        "line": 1,
                        "character": 5
                    },
                    "end": {
                        "line": 1,
                        "character": 5
                    }
                },
                "newText": " "
            },
            {
                "range": {
                    "start": {
                        "line": 1,
                        "character": 2
                    },
                    "end": {
                        "line": 1,
                        "character": 2
                    }
                },
                "newText": " "
            }
        ];
        //console.log(JSON.stringify(edits, null, 4));
        assert.deepEqual(edits, expected);
    });

});