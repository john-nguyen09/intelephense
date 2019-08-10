import * as TreeSitterParser from 'tree-sitter';
import * as Php from 'tree-sitter-php';
import { Position } from 'vscode-languageserver';

/**
 * A helper functions bridge to tree sitter
 */
export namespace Parser {
    export function parse(src: string, previousTree?: TreeSitterParser.Tree) {
        // Create parser every parse because it can causes error
        // if parsing multiple files.
        // Following is an example of error occur on the last source:
        /*
        const srcs = [
        `<?php
    namespace Foo;
    class Bar {}
`,
        `<?php
    namespace Baz;
    use Foo\\Bar as Fuz;
    $obj = new F
`,
        `<?php
        namespace Foo;
        class Bar {}
    `,
        `<?php
        namespace Baz;
        $var = new \\Foo\\Bar;
    `,
        `
    <?php
        $c = new class {};
    `
    ];
        */
        // However if only the last src is parsed then there will be
        // no error
        const parser = new TreeSitterParser();
        parser.setLanguage(Php);
        return parser.parse(src, previousTree);
    }

    export function toPosition(point: TreeSitterParser.Point) {
        return Position.create(
            point.row, point.column
        );
    }

    export function toPoint(position: Position) {
        return {
            row: position.line, column: position.character
        };
    }
}