import { SymbolStore, SymbolTable } from '../src/symbolStore';
import { SymbolProvider } from '../src/providers/symbolProvider';
import * as util from '../src/utils';
import { assert } from 'chai';
import 'mocha';
import * as fs from 'fs';
import * as path from 'path';
import { ParsedDocument, ParsedDocumentStore } from '../src/parsedDocument';
import * as lsp from 'vscode-languageserver-types';
import LevelConstructor from 'levelup';
import MemDown from 'memdown';

describe('symbolProviders', () => {
    it('provide symbols', async () => {
        let src = fs.readFileSync(path.join(__dirname, '/fixtures/symbols.php')).toString();
        const level = LevelConstructor(MemDown());
        const docStore = new ParsedDocumentStore();
        let symbolStore = new SymbolStore(level, docStore);
        let document = new ParsedDocument('test', src);
        let symbolTable = SymbolTable.create(document);

        await symbolStore.add(symbolTable);

        let symbolProvider = new SymbolProvider(symbolStore, docStore);

        let results = await symbolProvider.provideDocumentSymbols('test');
        const expected: lsp.SymbolInformation[] = [
            {
                kind: lsp.SymbolKind.Constant,
                name: "TEST_CONST1",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 2,
                            character: 6
                        },
                        end: {
                            line: 2,
                            character: 21
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Constant,
                name: "TEST_CONST",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 3,
                            character: 0
                        },
                        end: {
                            line: 3,
                            character: 23
                        }
                    }
                },
                containerName: undefined,
            },
            {
                kind: lsp.SymbolKind.Function,
                name: "testFunction",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 7,
                            character: 0
                        },
                        end: {
                            line: 10,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Function,
                name: "testFunction2",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 12,
                            character: 0
                        },
                        end: {
                            line: 15,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Class,
                name: "TestClass",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 17,
                            character: 0
                        },
                        end: {
                            line: 39,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Constant,
                name: "CLASS_CONSTANT",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 19,
                            character: 10
                        },
                        end: {
                            line: 19,
                            character: 28
                        }
                    }
                },
                containerName: "TestClass"
            },
            {
                kind: lsp.SymbolKind.Constant,
                name: "CONSTANT1",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 20,
                            character: 10
                        },
                        end: {
                            line: 20,
                            character: 23
                        }
                    }
                },
                containerName: "TestClass"
            },
            {
                kind: lsp.SymbolKind.Constant,
                name: "CONSTANT2",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 20,
                            character: 25
                        },
                        end: {
                            line: 20,
                            character: 40
                        }
                    }
                },
                containerName: "TestClass"
            },
            {
                kind: lsp.SymbolKind.Constant,
                name: "PI",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 20,
                            character: 42
                        },
                        end: {
                            line: 20,
                            character: 51
                        }
                    }
                },
                containerName: "TestClass"
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "testMethod",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 30,
                            character: 4
                        },
                        end: {
                            line: 33,
                            character: 5
                        }
                    }
                },
                containerName: "TestClass"
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "testMethod2",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 35,
                            character: 4
                        },
                        end: {
                            line: 38,
                            character: 5
                        }
                    }
                },
                containerName: "TestClass"
            },
            {
                kind: lsp.SymbolKind.Class,
                name: "TestClass2",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 41,
                            character: 0
                        },
                        end: {
                            line: 44,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Interface,
                name: "TestInterface",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 46,
                            character: 0
                        },
                        end: {
                            line: 50,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "testInterfaceMethod",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 48,
                            character: 4
                        },
                        end: {
                            line: 48,
                            character: 42
                        }
                    }
                },
                containerName: "TestInterface"
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "testInterfaceMethod2",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 49,
                            character: 4
                        },
                        end: {
                            line: 49,
                            character: 43
                        }
                    }
                },
                containerName: "TestInterface"
            },
            {
                kind: lsp.SymbolKind.Interface,
                name: "TestInterface2",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 52,
                            character: 0
                        },
                        end: {
                            line: 55,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "testInterfaceMethod3",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 54,
                            character: 4
                        },
                        end: {
                            line: 54,
                            character: 43
                        }
                    }
                },
                containerName: "TestInterface2"
            },
            {
                kind: lsp.SymbolKind.Class,
                name: "TestClass3",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 57,
                            character: 0
                        },
                        end: {
                            line: 60,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Module,
                name: "TestTrait",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 62,
                            character: 0
                        },
                        end: {
                            line: 68,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "traitMethod1",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 64,
                            character: 4
                        },
                        end: {
                            line: 67,
                            character: 5
                        }
                    }
                },
                containerName: "TestTrait"
            },
            {
                kind: lsp.SymbolKind.Class,
                name: "TestClass4",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 70,
                            character: 0
                        },
                        end: {
                            line: 78,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "staticMethod1",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 74,
                            character: 4
                        },
                        end: {
                            line: 77,
                            character: 5
                        }
                    }
                },
                containerName: "TestClass4"
            },
            {
                kind: lsp.SymbolKind.Class,
                name: "#anon#test#1164",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 80,
                            character: 0
                        },
                        end: {
                            line: 85,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "testInterfaceMethod3",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 81,
                            character: 4
                        },
                        end: {
                            line: 84,
                            character: 5
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Function,
                name: "#anon#test#1336",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 88,
                            character: 17
                        },
                        end: {
                            line: 90,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Class,
                name: "TestAbstract1",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 98,
                            character: 0
                        },
                        end: {
                            line: 101,
                            character: 1
                        }
                    }
                },
                containerName: undefined
            },
            {
                kind: lsp.SymbolKind.Method,
                name: "testFunction1",
                location: {
                    uri: "test",
                    range: {
                        start: {
                            line: 100,
                            character: 4
                        },
                        end: {
                            line: 100,
                            character: 45
                        }
                    }
                },
                containerName: "TestAbstract1"
            }
        ];

        assert.deepEqual(results, expected);
    });
});
