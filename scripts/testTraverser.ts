import { TreeTraverser, TreeVisitor } from "../src/types";
import { Traverser } from "../src/traverser";
import { SyntaxNode } from "tree-sitter";
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Parser } from "../src/parser";

const readDirAsync = promisify(fs.readdir);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

class DummyVisitor implements TreeVisitor<SyntaxNode> {
    public haltTraverse = false;
    public output = '';
    public spine = '';

    preorder(node: SyntaxNode, spine: SyntaxNode[]) {
        this.output += `->${node.type}`;
        this.spine += spine.map(parent => {
            return parent.type;
        }).join(':') + '---';

        return true;
    }


    postorder(node: SyntaxNode, spine: SyntaxNode[]) {
        this.output += `<-${node.type}`;
        this.spine += spine.map(parent => {
            return parent.type;
        }).join(':') + '---';
    }
}

async function main(){
    const caseDir = path.join(__dirname, '..', 'test', 'fixtures');
    const files = await readDirAsync(caseDir);
    let numPasses = 0;
    let numFails = 0;

    let numSpinePasses = 0;
    let numSpineFails = 0;

    for (const file of files) {
        const filePath = path.join(caseDir, file);

        if (path.extname(file) === '.php') {
            const data = await readFileAsync(filePath);
            const src = data.toString();
            const tree = Parser.parse(src);

            const stableVisitor = new DummyVisitor();
            const stableTraverser = new TreeTraverser<SyntaxNode>([tree.rootNode]);
            stableTraverser.traverse(stableVisitor);

            const experimentalVisitor = new DummyVisitor();
            const experimentalTraverser = new Traverser<SyntaxNode>(tree.rootNode);
            experimentalTraverser.traverse(experimentalVisitor);

            if (stableVisitor.output !== experimentalVisitor.output) {
                console.log(`${filePath} failed`);
                numFails++;
            } else {
                numPasses++;
            }

            if (stableVisitor.spine !== experimentalVisitor.spine) {
                numSpineFails++;
                console.log({
                    stable: stableVisitor.spine,
                    experimental: experimentalVisitor.spine,
                })
            } else {
                numSpinePasses++;
            }
        }

        break;
    }

    console.log(`Passing: ${numPasses}`);
    console.log(`Failing: ${numFails}`);
    console.log(`Spine passing: ${numSpinePasses}`);
    console.log(`Spine failing: ${numSpineFails}`);
};

main();
