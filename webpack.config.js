/* eslint-env node */
/* eslint-disable @typescript-eslint/no-var-requires */

const ForkTsCheckerWebpackPlugin = require( 'fork-ts-checker-webpack-plugin' );
const packageJson = require( './package.json' );
const path = require( 'path' );
const webpack = require( 'webpack' );

module.exports = ( env, argv ) => {
  const VERSION = packageJson.version;
  const DEV = argv.mode === 'development';
  console.info( `Webpack: Building ${ packageJson.name } v${ VERSION } under ${ argv.mode } settings...` );

  const banner = DEV
    ? `${ packageJson.name } v${ VERSION }
${ packageJson.description }
Copyright (c) 2019 ${ packageJson.author }
${ packageJson.name } is distributed under the MIT License
https://opensource.org/licenses/MIT
Repository: ${ packageJson.repository }`
    : `${ packageJson.name } v${ VERSION } - (c) ${ packageJson.author }, MIT License`;

  return {
    entry: path.resolve( __dirname, 'src/index.ts' ),
    output: {
      path: path.join( __dirname, 'dist' ),
      filename: DEV ? 'wavenerd-deck.js' : 'wavenerd-deck.min.js',
      library: 'WAVENERD_DECK',
      libraryTarget: 'umd',
      globalObject: 'this',
    },
    resolve: {
      extensions: [ '.js', '.json', '.ts' ],
    },
    module: {
      rules: [
        { test: /\.(glsl|frag|vert)$/, use: [ 'raw-loader' ] },
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [
            {
              loader: 'ts-loader',
              options: { happyPackMode: true, transpileOnly: true }
            }
          ]
        },
      ],
    },
    optimization: {
      minimize: !DEV
    },
    devServer: {
      contentBase: path.resolve( __dirname, './' ),
      publicPath: '/dist/',
      openPage: 'example/example.html',
      watchContentBase: true,
      inline: true,
      hot: true
    },
    devtool: DEV ? 'inline-source-map' : false,
    plugins: [
      new webpack.BannerPlugin( banner ),
      new webpack.DefinePlugin( {
        'process.env': {
          DEV,
          VERSION: `"${ VERSION }"`
        },
      } ),
      ...( DEV ? [
        new webpack.NamedModulesPlugin(),
        new ForkTsCheckerWebpackPlugin( { checkSyntacticErrors: true } ),
      ] : [
        // nothing
      ] ),
    ],
  };
};
