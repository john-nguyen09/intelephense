import { TreeLike, TreeVisitor } from "../types";
import { Stack } from "./internal/stack";
import { Cursor } from "./internal/cursor";

export class Traverser<T extends TreeLike> {
    constructor(private root: T) { }

    traverse(visitor: TreeVisitor<T>) {
        const stack = new Stack<T>(this.root);
        // perf: avoid bounds check deopt when calling Queue#peek later,
        // instead we put an initial value
        const ancestors = new Stack<T | null>(null);
        const cursor = new Cursor<T>();
        
        // perf: use same hidden class than root node in order to
        // keep the stack monomorphic
        const dummy = Object.assign({}, this.root);

        while (!stack.isEmpty()) {
            const node = stack.pop();
            const parent = ancestors.peek();

            if (node === dummy) {
                cursor.moveUp();
                ancestors.pop();
                if (typeof visitor.postorder !== 'undefined' && parent) {
                    visitor.postorder(parent, cursor.toArray());
                }
                continue;
            }

            let descent = true;
            if (typeof visitor.preorder !== 'undefined') {
                descent = visitor.preorder(node, cursor);
            }

            cursor.moveNext();

            const children = node.children;

            if (children && children.length !== 0) {
                if (descent) {
                    stack.push(dummy);
                    stack.pushArrayReverse(<T[]>children);
                    cursor.moveDown(node);
                }

                if (node === parent) {
                    ancestors.pop();

                    if (typeof visitor.postorder !== 'undefined') {
                        visitor.postorder(node, cursor);
                    }
                }

                ancestors.push(node);
            } else {
                if (node === parent) {
                    ancestors.pop();
                }
                
                if (typeof visitor.postorder !== 'undefined') {
                    visitor.postorder(node, cursor);
                }
            }
        }
    }
}