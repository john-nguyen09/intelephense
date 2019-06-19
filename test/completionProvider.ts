import { CompletionProvider } from '../src/providers/completionProvider';
import { SymbolStore, SymbolTable } from '../src/symbolStore';
import { ParsedDocumentStore, ParsedDocument } from '../src/parsedDocument';
import * as lsp from 'vscode-languageserver-types';
import { assert } from 'chai';
import 'mocha';
import { ReferenceReader } from '../src/referenceReader';
import {ReferenceStore} from '../src/reference';
import * as fs from 'fs';
import { CompletionItem } from 'vscode-languageserver-types';
import * as path from 'path';
import LevelConstructor from 'levelup';
import MemDown from 'memdown';

var noCompletions: lsp.CompletionList = {
    items: [],
    isIncomplete: false
};

var objectCreationSrc =
    `<?php
    class Foo {
        function __construct($p){}
    }
    $var = new F
`;

var scopedAccessSrc =
    `<?php
    class Test {
        public const FOO = 1;
        public static $bar = 1;
        public static function baz(){}
        private static $baz = 1;
    }
    $var = Test::FOO;
    $var = Test::$bar;
    $var = Test::baz();
`;

var objectSrc =
    `<?php
    class Test {
        public $foo;
        public function bar(){}
        private function baz(){}
        static function foo(){}
    }

    $var = new Test();
    $var->b
`;

var objSrc2 =
    `<?php
use Foo\\Bar\\Baz;
$var = new Baz();
$var->
`;

var variableSrc =
    `<?php
    function foo($foo){ 
        $bar = $foo;
    }
    $baz = 2;
    $
`;

var nameSrc =
    `<?php
    class Foo {}
    class Bar {}
    b
    function bar() {}
`;

var nsUse =
    `<?php
    namespace Bar;
    use F

    class Foo {}
    class Baz {}
`;

var classBaseSrc =
    `<?php
    class Foo {}
    interface FooInterface {}
    class Bar extends F
`;

var implementsSrc =
    `<?php
    class Foo {}
    interface FooInterface {}
    class Bar extends Foo implements F 
`;

var interfaceBaseSrc =
    `<?php
    class Baz {}
    interface Bar {}
    interface Foo extends B
`;

var groupUseSrc =
    `<?php
    namespace Foo\\Bar;
    use Foo\\{
        B
    }

    class Baz {}
`;

var methodTagSrc =
    `<?php
    /**
     * @method int bar()
     */
     class Foo {}
     $var = new Foo();
     $var->
`;

var propertyTagSrc =
    `<?php
    /**
     * @property int $prop
     */
    class Foo {}
    $var = new Foo();
    $var->

`;

var closureSrc =
    `<?php
    class Foo {
        function fooFn(){}
    }
    class Bar {
        function barFn(){}
    }
    $var = new Foo();
    $fn = function(string $param) use ($var){
        $bar = new Bar();
        $var->fooFn();
        echo $param;
        $bar->barFn();
    };
`;

var importSrc1 =
    `<?php
    namespace Foo;
    class Bar {}
`;

var importSrc2 =
    `<?php
    namespace Baz;
    use Foo\\Bar as Fuz;
    $obj = new F
`;

var traitSrc =
    `<?php
trait Bar {
    function barFn() { }
}
class Foo {
    use Bar;
    function fooFn() {
        $this->barFn();
    }
}
$foo = new Foo();
$foo->barFn();
`;

var prefixSrc =
    `<?php
function barFn() { }
namespace Foo;
barFn();
`;

var duplicateNameSrc =
    `<?php
class Foo {
    function fnA(){}
}
class Foo {
    function fnB(){}
    function fnC(){
        $this->fnA();
    }
}
$foo = new Foo();
$foo->fnA();
`;

var additionalUseDeclSrc1 =
    `<?php
namespace Foo;
class Bar {}
`;

var additionalUseDeclSrc2 =
    `<?php
namespace Baz;

$bar = new Bar
`;

var staticAndThisSrc =
    `<?php
class A {
    /** @return static */
    static function factory(){}
    /** @return $this */
    function setter() {}
}
class B extends A {
    function fn(){}
}
$var = B::factory();
$var->fn();
$var->setter()->fn();
`;

var varTypehintSrc =
    `<?php
class Foo {
    function foo(){}
}
class Bar {
    function bar(){}
}
/** @var Bar $bar */
$bar = new Foo;
$bar->bar();
$foo = new Bar;
/** @var Foo $foo */
$foo->foo();
`;

var encapsExprSrc =
`<?php
class Foo {
    function fn(){}
}
(new Foo())->fn();
`;

var foreachSrc =
`<?php
class Foo {
    function fn(){}
}
/**@var Foo[] $array */
foreach($array as $foo) {
    $foo->fn();
}
`;

var arrayDerefSrc =
`<?php
class Foo {
    function fn(){}
}
/**@var Foo[] $array */
$array[0]->fn();
`;

var staticAndSelfSrc = 
`<?php
class Foo {
    static function bar(){}
    function baz() {
        self::bar();
        static::bar();
    }
}
`;

var memberVisibilitySrc = 
`<?php
class Foo {
    private function privateFn(){}
    protected function protectedFn(){}
    function publicFn() {
        $this->
    }
}
`;

var useTraitClauseSrc = 
`<?php
namespace Foo;
trait Bar {}
namespace Bar;
class Foo {
    use Bar;
}
`;

var instanceOfSrc = 
`<?php
class Foo {
    function fn(){}
}
$var;
if($var instanceof Foo) {
    $var->fn();
}
`;

var declBodySrc1 =
`<?php
class Foo {
    p
}
`;

var declBodySrc2 =
`<?php
class Foo {
    public f 
}
`;

var extendsImplementsSrc =
`<?php
class Foo i
`;

var instanceOfTypeDesignatorSrc = 
`<?php
interface Baz {}
class Bar implements Baz {}
$var instanceof B
`;

var backslashSrc = 
`<?php
namespace Foo;
class Bar{}
namespace Baz;
\\Foo\\
`;

async function setup(src: string | string[]) {
    const level = LevelConstructor(MemDown());
    let parsedDocumentStore = new ParsedDocumentStore();
    let symbolStore = new SymbolStore(level, parsedDocumentStore);
    let refStore = new ReferenceStore();
    let completionProvider = new CompletionProvider(symbolStore, parsedDocumentStore, refStore);

    if (!Array.isArray(src)) {
        src = [src];
    }

    for (let n = 0; n < src.length; ++n) {
        let doc = new ParsedDocument('test' + (n > 0 ? n + 1 : ''), src[n]);
        parsedDocumentStore.add(doc);
        let table = SymbolTable.create(doc);
        await symbolStore.add(table);
        let refTable = await ReferenceReader.discoverReferences(doc, symbolStore);
        refStore.add(refTable);
    }

    return completionProvider;
}

function isEqual(item: lsp.CompletionItem, label: string, kind: lsp.CompletionItemKind) {
    return item.kind === kind && item.label === label;
}

describe('CompletionProvider', () => {

    describe('Closure', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(closureSrc);
        });

        it('use var completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 10, character: 16 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'fooFn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

        it('internal var completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 12, character: 16 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'barFn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

        it('param var completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 11, character: 16 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, '$param');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Variable);
        });

    });

    describe('Object creation', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(objectCreationSrc);
        });

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 4, character: 16 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'Foo');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Constructor);
            assert.equal(completions.items[0].insertText, 'Foo($0)');
        });

    });

    describe('Scoped access', () => {

        let completionProvider: CompletionProvider;

        before(async function () {
            completionProvider = await setup(scopedAccessSrc);
            //console.log(JSON.stringify(completionProvider.symbolStore, null, 4));
        });

        it('::', async function () {
            let completions = await completionProvider.provideCompletions('test', { line: 7, character: 17 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 3);
            completions.items.forEach((x) => {
                assert.isTrue(
                    isEqual(x, '$bar', lsp.CompletionItemKind.Property) ||
                    isEqual(x, 'FOO', lsp.CompletionItemKind.Value) ||
                    isEqual(x, 'baz', lsp.CompletionItemKind.Method)
                );
            });

        });


        it('$', async function () {
            let completions = await completionProvider.provideCompletions('test', { line: 8, character: 18 });
            assert.equal(completions.items[0].label, '$bar');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Property);
            //console.log(JSON.stringify(completions, null, 4));
        });

        it('Identifier', async function () {
            let completions = await completionProvider.provideCompletions('test', { line: 9, character: 18 });
            assert.equal(completions.items.length, 2);
            completions.items.forEach((x) => {
                assert.isTrue(
                    isEqual(x, '$bar', lsp.CompletionItemKind.Property) || //fuzzy search should also get properties
                    isEqual(x, 'baz', lsp.CompletionItemKind.Method)
                );
            });
            //console.log(JSON.stringify(completions, null, 4));
        });


    });

    describe('Object access', function () {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(objectSrc);
        });

        it('->', async function () {
            let completions = await completionProvider.provideCompletions('test', { line: 9, character: 10 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 3);
            completions.items.forEach((x) => {
                assert.isTrue(
                    isEqual(x, 'foo', lsp.CompletionItemKind.Property) ||
                    isEqual(x, 'bar', lsp.CompletionItemKind.Method) ||
                    isEqual(x, 'foo', lsp.CompletionItemKind.Method)
                );
            });

        });

        it('Identifier', async function () {
            let completions = await completionProvider.provideCompletions('test', { line: 9, character: 11 });
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, 'bar');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

        it('@method', async function () {
            let provider = await setup(methodTagSrc);
            let completions = await provider.provideCompletions('test', { line: 6, character: 11 });
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, 'bar');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);

        });

        it('@property', async function () {
            let provider = await setup(propertyTagSrc);
            let completions = await provider.provideCompletions('test', { line: 6, character: 10 });
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, 'prop');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Property);

        });

        it('with use decl', async function () {

            let src = `<?php
            namespace Foo\\Bar;
            class Baz {
                function fn() {}
            }
            `;

            let provider = await setup([src, objSrc2]);
            let completions = await provider.provideCompletions('test2', { line: 3, character: 6 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, 'fn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        })

    });

    describe('Variables', function () {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(variableSrc);
        });

        it('Suggest variable from correct scope', async function () {
            let completions = await completionProvider.provideCompletions('test', { line: 5, character: 5 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, '$baz');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Variable);

        });

        it('Parameters', async function () {
            let completions = await completionProvider.provideCompletions('test', { line: 2, character: 17 });
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, '$foo');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Variable);
            //console.log(JSON.stringify(completions, null, 4));
        });

    });

    describe('Names', function () {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(nameSrc);
        });

        it('name completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 3, character: 5 });
            //console.log(JSON.stringify(completions, null, 4));
            //should also suggest keywords abstract, break, global
            assert.equal(completions.items.length, 4);
            completions.items.forEach((x) => {
                assert.isTrue(
                    isEqual(x, 'abstract', lsp.CompletionItemKind.Keyword) ||
                    isEqual(x, 'break', lsp.CompletionItemKind.Keyword) ||
                    isEqual(x, 'global', lsp.CompletionItemKind.Keyword) ||
                    isEqual(x, 'bar', lsp.CompletionItemKind.Function)
                );
            });

        });

    });

    describe('Namespace use', function () {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(nsUse);
        });

        it('use completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 2, character: 9 });
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, 'Foo');
            assert.equal(completions.items[0].insertText, 'Bar\\Foo');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Class);
            //console.log(JSON.stringify(completions, null, 4));
        });

    });

    describe('Class extends', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(classBaseSrc);
        });

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 3, character: 23 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, 'Foo');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Class);
        });

    });

    describe('Implements', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(implementsSrc);
        });

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 3, character: 38 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, 'FooInterface');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Interface);
        });

    });

    describe('Interface extends', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(interfaceBaseSrc);
        });

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 3, character: 27 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 1);
            assert.equal(completions.items[0].label, 'Bar');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Interface);
        });

    });

    describe('Use group', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(groupUseSrc);
        });

        let expected = <lsp.CompletionItem[]>[
            {
                "kind": 9,
                "label": "Bar"
            },
            {
                "kind": 7,
                "label": "Bar\\Baz"
            }
        ];

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 3, character: 9 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.deepEqual(completions.items, expected);
        });

    });

    describe('Imports', async () => {
        const level = LevelConstructor(MemDown());
        let parsedDocumentStore = new ParsedDocumentStore();
        let symbolStore = new SymbolStore(level, parsedDocumentStore);
        let refStore = new ReferenceStore();
        let completionProvider = new CompletionProvider(symbolStore, parsedDocumentStore, refStore);
        let doc = new ParsedDocument('doc1', importSrc1);
        let doc2 = new ParsedDocument('doc2', importSrc2);
        parsedDocumentStore.add(doc);
        await symbolStore.add(SymbolTable.create(doc));
        parsedDocumentStore.add(doc2);
        await symbolStore.add(SymbolTable.create(doc2));
        refStore.add(await ReferenceReader.discoverReferences(doc, symbolStore));
        refStore.add(await ReferenceReader.discoverReferences(doc2, symbolStore));

        let expected = <lsp.CompletionList>{
            "items": [
                {
                    "kind": 4,
                    "label": "Fuz",
                    "detail": "use Foo\\Bar as Fuz",
                },
                {
                    kind: 9,
                    label: 'Foo'
                }
            ],
            "isIncomplete": false
        };

        it('should provide import aliases', async () => {

            let completions = await completionProvider.provideCompletions('doc2', { line: 3, character: 16 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.deepEqual(completions, expected);
        });

    });

    describe('traits', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(traitSrc);
        });

        it('internal completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 7, character: 16 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'barFn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

        it('external completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 11, character: 7 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'barFn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

    });

    describe('ns prefix', () => {

        it('prefix enabled', async function () {
            let completionProvider = await setup(prefixSrc);
            var completions = await completionProvider.provideCompletions('test', { line: 3, character: 3 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].insertText, '\\barFn()');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Function);
        });

        it('prefix disabled', async function () {
            let completionProvider = await setup(prefixSrc);
            completionProvider.config = { backslashPrefix: false, maxItems: 100, addUseDeclaration: false };
            var completions = await completionProvider.provideCompletions('test', { line: 3, character: 3 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].insertText, 'barFn()');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Function);
        });

    });

    describe('stubs - duplicate names', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(duplicateNameSrc);
        });

        it('all methods external', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 11, character: 7 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 3);
            let fnNames = ['fnA', 'fnB', 'fnC'];
            assert.oneOf(completions.items[0].label, fnNames);
            assert.oneOf(completions.items[1].label, fnNames);
        });

        it('all methods internal', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 7, character: 16 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items.length, 3);
            let fnNames = ['fnA', 'fnB', 'fnC'];
            assert.oneOf(completions.items[0].label, fnNames);
            assert.oneOf(completions.items[1].label, fnNames);
        });


    });

    describe('additional use decl', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup([additionalUseDeclSrc1, additionalUseDeclSrc2]);
        });

        let expected = [
            {
                range: {
                    start: {
                        line: 1,
                        character: 14
                    },
                    end: {
                        line: 1,
                        character: 14
                    }
                },
                newText: "\n\nuse Foo\\Bar;\n"
            }
        ];

        it('additional text edit', async function () {
            var completions = await completionProvider.provideCompletions('test2', { line: 3, character: 14 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.deepEqual(completions.items[0].additionalTextEdits, expected);
        });

        it('no additional text edit if disabled', async function () {
            let completionProvider = await setup([additionalUseDeclSrc1, additionalUseDeclSrc2]);
            completionProvider.config = { backslashPrefix: true, maxItems: 100, addUseDeclaration: false };
            var completions = await completionProvider.provideCompletions('test2', { line: 3, character: 14 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.isUndefined(completions.items[0].additionalTextEdits);
        });

    });

    describe('$this and static return types', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(staticAndThisSrc);
        });

        it('static', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 11, character: 7 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'fn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

        it('$this', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 12, character: 17 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'fn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });


    });

    describe('@var typehinting', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(varTypehintSrc);
        });

        it('overrides assignment', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 9, character: 8 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'bar');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

        it('non assignment context', async function() {
            var completions = await completionProvider.provideCompletions('test', { line: 12, character: 8 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'foo');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });


    });

    describe('encapsulated expr member access', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(encapsExprSrc);
        });

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 4, character: 14 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'fn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

    });

    describe('foreach', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(foreachSrc);
        });

        it('value', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 6, character: 11 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'fn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

    });

    describe('array deref', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(arrayDerefSrc);
        });

        it('members', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 5, character: 12 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'fn');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

    });

    describe('static and self member access', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(staticAndSelfSrc);
        });

        it('static', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 5, character: 18 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'bar');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

        it('self', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 4, character: 17 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'bar');
            assert.equal(completions.items[0].kind, lsp.CompletionItemKind.Method);
        });

    });


    describe('member visibility', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(memberVisibilitySrc);
        });

        it('this private and protected', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 5, character: 15 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.lengthOf(completions.items, 3);
        });

    });

    describe('use trait clause', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(useTraitClauseSrc);
        });

        it('traits', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 5, character: 9 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'Bar');
        });

    });

    describe('instanceof', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(instanceOfSrc);
        });

        it('members', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 6, character: 11 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.equal(completions.items[0].label, 'fn');
        });

    });

    describe('class decl body', () => {
        
        it('visibility mod', async ()=>{
            let completionProvider = await setup(declBodySrc1);
            let expected = <lsp.CompletionItem[]>[
                    {
                        label: "public",
                        kind: 14
                    },
                    {
                        label: "private",
                        kind: 14
                    },
                    {
                        label: "protected",
                        kind: 14
                    }
                ];
    
            var completions = await completionProvider.provideCompletions('test', { line: 2, character: 5 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.deepEqual(completions.items, expected);

        });

        it('f', async ()=>{
            let completionProvider = await setup(declBodySrc2);
            let expected = <lsp.CompletionItem[]>[
                    {
                        label:"final",
                        kind:14
                    },
                    {
                        label: "function",
                        kind: 14
                    }
                ];
    
            var completions = await completionProvider.provideCompletions('test', { line: 2, character: 12 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.deepEqual(completions.items, expected);

        });
    });

    describe('extends implements', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(extendsImplementsSrc);
        });

        let expected = <lsp.CompletionItem[]>[
            {
                "kind": 14,
                "label": "extends"
            },
            {
                "kind": 14,
                "label": "implements"
            }
        ];

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 1, character: 11 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.deepEqual(completions.items, expected);
        });

    });

    describe('instanceOfTypeDesignator', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(instanceOfTypeDesignatorSrc);
        });

        let expected = <CompletionItem[]>[
            {
                "kind": 7,
                "label": "Bar"
            },
            {
                "kind": 8,
                "label": "Baz"
            },
        ];

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 3, character: 17 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.deepEqual(completions.items, expected);
        });

    });

    describe('trailing backslash', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            completionProvider = await setup(backslashSrc);
        });

        let expected = <lsp.CompletionItem[]>[
            {
                "kind": 7,
                "label": "Bar"
            }
        ];

        it('completions', async function () {
            var completions = await completionProvider.provideCompletions('test', { line: 4, character: 5 });
            //console.log(JSON.stringify(completions, null, 4));
            assert.deepEqual(completions.items, expected);
        });

    });

    describe('Global variable', () => {

        let completionProvider: CompletionProvider;
        before(async function () {
            let files = [
                path.join(__dirname, '/fixtures/global-variables.php'),
                path.join(__dirname, '/fixtures/completions.php')
            ];
            let filesContent: string[] = [];

            for (let file of files) {
                filesContent.push(fs.readFileSync(file).toString());
            }

            completionProvider = await setup(filesContent);
        });

        it('Member access', async function () {
            let completions = await completionProvider.provideCompletions('test2', { line: 5, character: 9 });
            let exptectedItems = [
                {
                    kind: lsp.CompletionItemKind.Method,
                    label: 'read_records',
                    detail: 'read_records()',
                    sortText: 'read_records',
                    insertText: 'read_records()'
                }, {
                    kind: lsp.CompletionItemKind.Method,
                    label: 'write_records',
                    detail: 'write_records()',
                    sortText: 'write_records',
                    insertText: 'write_records()'
                }
            ];
            
            assert.deepEqual(completions.items, exptectedItems);

            completions = await completionProvider.provideCompletions('test2', { line: 8, character: 5 });
            assert.deepEqual(completions.items, exptectedItems);
        });

    });

});








