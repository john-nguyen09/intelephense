import { Intelephense } from '../src/intelephense';
import { pathToUri } from '../src/util';
import * as path from 'path';

describe('Test server', () => {
    it('should initialise', async () => {
        const rootPath = path.join(__dirname, 'fixtures');

        await Intelephense.initialise({
            processId: 0,
            rootPath: rootPath,
            rootUri: pathToUri(rootPath),
            capabilities: {
                
            }
        });
    });
});