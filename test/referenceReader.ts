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
import LevelConstructor from 'levelup';
import MemDown from 'memdown';
import { TypeString } from '../src/typeString';

async function readReferences(src:string) {
    const level = LevelConstructor(MemDown());
    let store = new SymbolStore(level);
    let doc = new ParsedDocument('test', src);
    let table = SymbolTable.create(doc);
    //console.log(JSON.stringify(table, null, 4));
    await store.add(table);
    return await ReferenceReader.discoverReferences(doc, store);

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

    it('issue 82', async () => {

        let refTable = await readReferences(issue82Src);


    });

    it('@global tag', async () => {
        let src = fs.readFileSync(path.join(__dirname, '/fixtures/global-variables.php')).toString();
        let refTable = await readReferences(src);
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

    it('should have reference to self and $this', async () => {
        let src = fs.readFileSync(path.join(__dirname, '/fixtures/class-with-define.php')).toString();
        let refTable = await readReferences(src);
        let references = refTable.references();

        let expected: Reference[] = [
            {
                "kind": SymbolKind.Class,
                "name": "FirstClass",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 2,
                            "character": 6
                        },
                        "end": {
                            "line": 2,
                            "character": 16
                        }
                    }
                }
            },
            {
                "kind": SymbolKind.Method,
                "name": "thisWorks",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 4,
                            "character": 24
                        },
                        "end": {
                            "line": 4,
                            "character": 33
                        }
                    }
                },
                "scope": "FirstClass"
            },
            {
                "kind": SymbolKind.Method,
                "name": "__construct",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 9,
                            "character": 17
                        },
                        "end": {
                            "line": 9,
                            "character": 28
                        }
                    }
                },
                "scope": "FirstClass"
            },
            {
                "kind": SymbolKind.Class,
                "name": "FirstClass",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 11,
                            "character": 2
                        },
                        "end": {
                            "line": 11,
                            "character": 6
                        }
                    }
                },
                "altName": "self"
            },
            {
                "kind": SymbolKind.Method,
                "name": "thisWorks",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 11,
                            "character": 8
                        },
                        "end": {
                            "line": 11,
                            "character": 17
                        }
                    }
                },
                "scope": "FirstClass"
            },
            {
                "kind": SymbolKind.Variable,
                "name": "$this",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 12,
                            "character": 2
                        },
                        "end": {
                            "line": 12,
                            "character": 7
                        }
                    }
                },
                "type": "FirstClass"
            },
            {
                "kind": SymbolKind.Method,
                "name": "thisWorks",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 12,
                            "character": 9
                        },
                        "end": {
                            "line": 12,
                            "character": 18
                        }
                    }
                },
                "scope": "FirstClass"
            },
            {
                "kind": SymbolKind.Function,
                "name": "define",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 16,
                            "character": 0
                        },
                        "end": {
                            "line": 16,
                            "character": 6
                        }
                    }
                }
            },
            {
                "kind": SymbolKind.Class,
                "name": "SecondClass",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 18,
                            "character": 6
                        },
                        "end": {
                            "line": 18,
                            "character": 17
                        }
                    }
                }
            },
            {
                "kind": SymbolKind.Method,
                "name": "thisDoesNotWork",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 20,
                            "character": 24
                        },
                        "end": {
                            "line": 20,
                            "character": 39
                        }
                    }
                },
                "scope": "SecondClass"
            },
            {
                "kind": SymbolKind.Method,
                "name": "__construct",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 25,
                            "character": 17
                        },
                        "end": {
                            "line": 25,
                            "character": 28
                        }
                    }
                },
                "scope": "SecondClass"
            },
            {
                "kind": SymbolKind.Class,
                "name": "SecondClass",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 27,
                            "character": 2
                        },
                        "end": {
                            "line": 27,
                            "character": 6
                        }
                    }
                },
                "altName": "self"
            },
            {
                "kind": SymbolKind.Method,
                "name": "thisDoesNotWork",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 27,
                            "character": 8
                        },
                        "end": {
                            "line": 27,
                            "character": 23
                        }
                    }
                },
                "scope": "SecondClass"
            },
            {
                "kind": SymbolKind.Variable,
                "name": "$this",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 28,
                            "character": 2
                        },
                        "end": {
                            "line": 28,
                            "character": 7
                        }
                    }
                },
                "type": "SecondClass"
            },
            {
                "kind": SymbolKind.Method,
                "name": "thisDoesNotWork",
                "location": {
                    "uri": "test",
                    "range": {
                        "start": {
                            "line": 28,
                            "character": 9
                        },
                        "end": {
                            "line": 28,
                            "character": 24
                        }
                    }
                },
                "scope": "SecondClass"
            }
        ];

        for (let i = 0; i < references.length; i++) {
            if (!references[i].scope) {
                continue;
            }

            references[i].scope = await TypeString.resolve(references[i].scope);
        }

        assert.deepEqual(references, expected);
    });

});
