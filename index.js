'use strict';
var fs = require('fs');
var path = require('path');
var Readable = require('stream').Readable;
var glob = require('glob');
var dargs = require('dargs');
var mkdirp = require('mkdirp');
var rimraf = require('rimraf');
var md5Hex = require('md5-hex');
var spawn = require('win-spawn');
var gutil = require('gulp-util');
var glob2base = require('glob2base');
var assign = require('object-assign');
var convert = require('convert-source-map');
var eachAsync = require('each-async');
var osTmpdir = require('os-tmpdir');
var pathExists = require('path-exists');

var logger = require('./logger');
var utils = require('./utils');

var emitErr = utils.emitErr;
var uniqueIntermediateDirectory = utils.uniqueIntermediateDirectory;

function gulpRubySass (source, options) {
	var cwd = process.cwd();

	options = assign({
		tempDir: osTmpdir(),
		verbose: false,
		sourcemap: false,
		emitCompileError: false
	}, options);

	options.update = true;

	var stream = new Readable({objectMode: true});
	stream._read = function () {}; 	// redundant but necessary

	// alert user that `container` is deprecated
	if (options.container) {
		gutil.log(gutil.colors.yellow(
			'The container option has been deprecated. Simultanious tasks work automatically now!\n' +
			'This will become an error in gulp-ruby-sass 2.0'
		));
	}

	// error if user tries to watch their files with the Sass gem
	if (options.watch || options.poll) {
		emitErr(stream, '`watch` and `poll` are not valid options for gulp-ruby-sass. Use `gulp.watch` to rebuild your files on change.');
	}

	// error if user tries to pass a Sass option to sourcemap
	if (typeof options.sourcemap !== 'boolean') {
		emitErr(stream, 'The sourcemap option must be true or false. See the readme for instructions on using Sass sourcemaps with gulp.');
	}

	options.sourcemap = options.sourcemap === true ? 'file' : 'none';

	// create temporary directory path for the task using current working
	// directory, source and options
	var intermediateDir = uniqueIntermediateDirectory(options.tempDir, source);

	// Sass's single file compilation doesn't create a destination directory
	mkdirp(intermediateDir);

	var base;

	// glob source
	if (glob.hasMagic(source)) {
		base = glob2base(new glob.Glob(source));
	}
	// directory source
	else if (fs.statSync(source).isDirectory()) {
		base = source;
	}
	// file source
	else {
		base = path.dirname(source);
	}

	var compileMappings = glob.sync(source)
		// remove _partials
		.filter(function (match) {
			return path.basename(match).indexOf('_') !== 0;
		})

		// create source:destination arguments for Sass
		.map(function (match) {
			var dest = match.replace(new RegExp('^' + base), intermediateDir);

			if (path.extname(dest) !== '') {
				dest = gutil.replaceExtension(dest, '.css');
			}

			return match + ':' + dest;
		});

	var args = dargs(options, [
		'bundleExec',
		'watch',
		'poll',
		'tempDir',
		'verbose',
		'emitCompileError',
		'container'
	]).concat(compileMappings);

	var command;

	if (options.bundleExec) {
		command = 'bundle';
		args.unshift('exec', 'sass');
	} else {
		command = 'sass';
	}

	// plugin logging
	if (options.verbose) {
		logger.verbose(command, args);
	}

	var sass = spawn(command, args);

	sass.stdout.setEncoding('utf8');
	sass.stderr.setEncoding('utf8');

	sass.stdout.on('data', function (data) {
		logger.stdout(stream, intermediateDir, data);
	});

	sass.stderr.on('data', function (data) {
		logger.stderr(stream, intermediateDir, data);
	});

	sass.on('error', function (err) {
		logger.error(stream, err);
	});

	sass.on('close', function (code) {
		if (options.emitCompileError && code !== 0) {
			emitErr(stream, 'Sass compilation failed. See console output for more information.');
		}

		glob(path.join(intermediateDir, '**', '*'), function (err, files) {
			if (err) {
				emitErr(stream, err);
			}

			eachAsync(files, function (file, i, next) {
				if (fs.statSync(file).isDirectory() || path.extname(file) === '.map') {
					next();
					return;
				}

				fs.readFile(file, function (err, data) {
					if (err) {
						emitErr(stream, err);
						next();
						return;
					}

					// rewrite file paths so gulp thinks the file came from cwd, not the
					// intermediate directory
					var vinylFile = new gutil.File({
						cwd: cwd,
						base: base,
						path: file.replace(intermediateDir, base)
					});

					// sourcemap integration
					// if we are managing sourcemaps and a sourcemap exists
					if (options.sourcemap === 'file' && pathExists.sync(file + '.map')) {

						// remove sourcemap comment; gulp-sourcemaps will add it back in
						data = new Buffer( convert.removeMapFileComments(data.toString()) );
						var sourcemapObject = JSON.parse(fs.readFileSync(file + '.map', 'utf8'));

						// create relative paths for sources
						sourcemapObject.sources = sourcemapObject.sources.map(function (sourcemapPath) {
							var absoluteSourcemapPath = decodeURI(path.resolve(
								'/',
								sourcemapPath.replace('file:///', '')
							));
							return path.relative(base, absoluteSourcemapPath);
						});

						vinylFile.sourceMap = sourcemapObject;
					}

					vinylFile.contents = data;
					stream.push(vinylFile);
					next();
					return;
				});
			}, function () {
				// cleanup previously generated files for next run
				// TODO: This kills caching. Keeping will push files through that are not in
				// the current gulp.src. We need to decide whether to use a Sass style caching
				// strategy, or a gulp style strategy, and what each would look like.
				rimraf(intermediateDir, function () {
					stream.push(null);
				});
			});
		});
	});

	return stream;
}

gulpRubySass.logError = function logError(err) {
	var message = new gutil.PluginError('gulp-ruby-sass', err);
	process.stderr.write(message + '\n');
	this.emit('end');
};

module.exports = gulpRubySass;
