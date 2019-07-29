import * as TreeSitterParser from 'tree-sitter';
import * as Php from 'tree-sitter-php';
import { Position } from 'vscode-languageserver';

/**
 * A helper functions bridge to tree sitter
 */
export namespace Parser {
    const parser = new TreeSitterParser();
    parser.setLanguage(Php);

    export function parse(src: string) {
        return parser.parse(src);
    }

    export function toPosition(point: TreeSitterParser.Point) {
        return Position.create(
            point.row, point.column
        );
    }
}