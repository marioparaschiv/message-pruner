// Plugins
import { typescriptPaths as paths } from 'rollup-plugin-typescript-paths';
import { nodeResolve as node } from '@rollup/plugin-node-resolve';
import { folderInput } from 'rollup-plugin-folder-input';
import { swc, minify } from 'rollup-plugin-swc3';
import json from '@rollup/plugin-json';

/** @type {import('rollup').RollupOptions} */
const config = {
	input: 'src',
	output: [
		{
			dir: 'dist',
			format: 'cjs',
		}
	],

	plugins: [
		folderInput(),
		paths({ preserveExtensions: true, nonRelative: process.platform === 'darwin' ? false : true }),
		node(),
		json(),
		swc({ tsconfig: false }),
		minify({ compress: true, mangle: true }),
	],

	onwarn(warning, warn) {
		if (warning.code === 'EVAL') return;
		warn(warning);
	}
};

export default config;