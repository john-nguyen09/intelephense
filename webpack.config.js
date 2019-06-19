const path = require("path");

module.exports = {
    mode: "production",
    devtool: "source-map",
    entry: "./src/server.ts",
    target: "node",
    output: {
        path: path.resolve(__dirname, 'lib'),
        filename: "main.js"
    },
    resolve: {
        // Add `.ts` and `.tsx` as a resolvable extension.
        extensions: [".ts", ".tsx", ".js"]
    },
    module: {
        rules: [
            // all files with a `.ts` or `.tsx` extension will be handled by `ts-loader`
            {
                test: /\.ts$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: 'tsconfig.build.json',
                        }
                    }
                ]
            }
        ]
    },
    externals: {
        vscode: 'commonjs vscode',
    }
};