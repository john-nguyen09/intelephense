import { SyntaxNode } from "tree-sitter";
import { PhpSymbol } from "../symbol";

export namespace Formatter {
    export function toString(node: SyntaxNode, depth: number = 0) {
        let str = '';

        const indent = (depth: number) => {
            let str = '';
            for (let i = 0; i < depth; i++) {
                str += '\t';
            }
            return str;
        }
        str += indent(depth);

        str += JSON.stringify({type: node.type});
        
        if (node.childCount > 0) {
            str += '\n';
            for (const child of node.children) {
                str += toString(child, depth + 1) + '\n';
            }
            str += indent(depth);
        }

        return str;
    }

    export function treeSitterOutput(output: string) {
        let result: string = '';
        let indent: number = 0;

        for (let i = 0; i < output.length; i++) {
            const ch = output.charAt(i);

            if (ch == '(') {
                if (i !== 0) {
                    result += '\n';
                }

                for (let j = 0; j < indent; j++) {
                    result += '\t';
                }

                result += ch;
                indent++;

                continue;
            } else if (ch == ')') {
                result += ch;

                indent--;

                continue;
            } else if (ch == ' ') {
                continue;
            }

            result += ch;
        }

        return result;
    }
}