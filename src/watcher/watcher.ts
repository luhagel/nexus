import anymatch from 'anymatch'
import { fork } from 'child_process'
import { SERVER_READY_SIGNAL } from '../framework/dev-mode'
import { saveDataForChildProcess } from '../framework/layout'
import { pog } from '../utils'
import cfgFactory from './cfg'
import { FileWatcher, watch } from './chokidar'
import { compiler } from './compiler'
import * as ipc from './ipc'
import { Opts, Process } from './types'
import { sendSigterm } from './utils'

const log = pog.sub('cli:dev:watcher')

/**
 * Entrypoint into the watcher system.
 */
export function createWatcher(opts: Opts): Promise<void> {
  return new Promise((resolve, reject) => {
    const cfg = cfgFactory(opts)

    compiler.init(opts)
    compiler.stop = stopRunner

    // Run ./dedupe.js as preload script
    if (cfg.dedupe) process.env.NODE_DEV_PRELOAD = __dirname + '/dedupe'

    //
    // Setup State
    //

    // Create a file watcher

    // TODO watch for changes to tsconfig and take correct action
    // TODO watch for changes to package json and take correct action (imagine
    // there could be nexus-future config in there)
    // TODO restart should take place following npm install/remove yarn
    // add/remove/install etc.
    // TODO need a way to test file matching given patterns. Hard to get right,
    // right now, and feedback loop sucks. For instance allow to find prisma
    // schema anywhere except in migrations ignore it, that is hard right now.

    const pluginWatchContributions = opts.plugins.reduce(
      (patterns, p) =>
        patterns.concat(p.dev.addToWatcherSettings.watchFilePatterns ?? []),
      [] as string[]
    )

    const pluginIgnoreContributions = opts.plugins.reduce(
      (patterns, p) =>
        patterns.concat(
          p.dev.addToWatcherSettings.listeners?.app?.ignoreFilePatterns ?? []
        ),
      [] as string[]
    )
    const isIgnoredByCoreListener = createPathMatcher({
      toMatch: pluginIgnoreContributions,
    })

    const watcher = watch(
      [opts.layout.sourceRoot, ...pluginWatchContributions],
      {
        ignored: ['./node_modules', './.*'],
        ignoreInitial: true,
        cwd: process.cwd(), // prevent globbed files and required files from being watched twice
      }
    )

    /**
     * Core watcher listener
     */
    // TODO: plugin listeners can probably be merged into the core listener
    watcher.on('all', (_event, file) => {
      if (isIgnoredByCoreListener(file)) {
        return log('global listener - DID NOT match file: %s', file)
      } else {
        log('global listener - matched file: %s', file)
        restartRunner(file)
      }
    })

    /**
     * Plugins watcher listeners
     */
    for (const p of opts.plugins) {
      if (p.dev.onFileWatcherEvent) {
        const isMatchedByPluginListener = createPathMatcher({
          toMatch:
            p.dev.addToWatcherSettings.listeners?.plugin?.allowFilePatterns,
          toIgnore:
            p.dev.addToWatcherSettings.listeners?.plugin?.ignoreFilePatterns,
        })

        watcher.on('all', (event, file, stats) => {
          if (isMatchedByPluginListener(file)) {
            log('plugin listener - matched file: %s', file)
            p.dev.onFileWatcherEvent!(event, file, stats, {
              restart: restartRunner,
            })
          } else {
            log('plugin listener - DID NOT match file: %s', file)
          }
        })
      }
    }

    watcher.on('error', error => {
      console.error('file watcher encountered an error: %j', error)
    })

    watcher.on('ready', () => {
      log('file watcher is ready')
    })

    // Create a mutable runner
    let runner = startRunnerDo()

    // Create some state to dedupe restarts. For example a rapid succession of
    // file changes will not trigger restart multiple times while the first
    // invocation was still running to completion.
    let runnerRestarting = false

    // Relay SIGTERM & SIGINT to the runner process tree
    //
    process.on('SIGTERM', () => {
      log('process got SIGTERM')
      stopRunnerOnBeforeExit().then(() => {
        resolve()
      })
    })

    process.on('SIGINT', () => {
      log('process got SIGINT')
      stopRunnerOnBeforeExit().then(() => {
        resolve()
      })
    })

    function startRunnerDo(): Process {
      return startRunner(opts, cfg, watcher, {
        onError: willTerminate => {
          stopRunner(runner, willTerminate)
          watcher.resume()
        },
      })
    }

    function stopRunnerOnBeforeExit() {
      if (runner.exited) return Promise.resolve()

      // TODO maybe we should be a timeout here so that child process hanging
      // will never prevent nexus-future dev from exiting nicely.
      return sendSigterm(runner)
        .then(() => {
          log('sigterm to runner process tree completed')
        })
        .catch(error => {
          console.warn(
            'attempt to sigterm the runner process tree ended with error: %O',
            error
          )
        })
    }

    function stopRunner(child: Process, willTerminate?: boolean) {
      if (child.exited || child.stopping) {
        return
      }
      child.stopping = true
      child.respawn = true
      if (child.connected === undefined || child.connected === true) {
        child.disconnect()

        if (willTerminate) {
          log(
            'Disconnecting from child. willTerminate === true so NOT sending sigterm to force runner end, assuming it will end itself.'
          )
        } else {
          log(
            'Disconnecting from child. willTerminate === false so sending sigterm to force runner end'
          )
          sendSigterm(child)
            .then(() => {
              log('sigterm to runner process tree completed')
            })
            .catch(error => {
              console.warn(
                'attempt to sigterm the runner process tree ended with error: %O',
                error
              )
            })
        }
      }
    }

    function restartRunner(file: string) {
      /**
       * Watcher is paused until the runner has stopped and properly restarted
       * We wait for the child process to send the watcher a message saying it's ready to be restarted
       * This prevents the runner to be run several times thus leading to an EPIPE error
       */
      watcher.pause()
      if (file === compiler.tsConfigPath) {
        log('reinitializing TS compilation')
        compiler.init(opts)
      }

      compiler.compileChanged(file, opts.onEvent)

      if (runnerRestarting) {
        log('already starting')
        return
      }

      runnerRestarting = true
      if (!runner.exited) {
        log('runner is still executing, will restart upon its exit')
        runner.on('exit', () => {
          runner = startRunnerDo()
          runnerRestarting = false
        })
        stopRunner(runner)
      } else {
        log('runner already exited, probably due to a previous error')
        runner = startRunnerDo()
        runnerRestarting = false
      }
    }
  })
}

/**
 * Returns the nesting-level of the given module.
 * Will return 0 for modules from the main package or linked modules,
 * a positive integer otherwise.
 */
function getLevel(mod: string) {
  const p = getPrefix(mod)

  return p.split('node_modules').length - 1
}

/**
 * Returns the path up to the last occurence of `node_modules` or an
 * empty string if the path does not contain a node_modules dir.
 */
function getPrefix(mod: string) {
  const n = 'node_modules'
  const i = mod.lastIndexOf(n)

  return ~i ? mod.slice(0, i + n.length) : ''
}

function isPrefixOf(value: string) {
  return function(prefix: string) {
    return value.indexOf(prefix) === 0
  }
}

function isRegExpMatch(value: string) {
  return function(regExp: string) {
    return new RegExp(regExp).test(value)
  }
}

/**
 * Start the App Runner. This occurs once on boot and then on every subsequent
 * file change in the users's project.
 */
function startRunner(
  opts: Opts,
  cfg: ReturnType<typeof cfgFactory>,
  watcher: FileWatcher,
  callbacks?: { onError?: (willTerminate: any) => void }
): Process {
  log('will spawn runner')

  const runnerModulePath = require.resolve('./runner')
  const childHookPath = compiler.getChildHookPath()

  log('using runner module at %s', runnerModulePath)
  log('using child-hook-path module at %s', childHookPath)

  // TODO: childHook is no longer used at all
  // const child = fork('-r' [runnerModulePath, childHookPath], {
  //
  // We are leaving this as a future fix, refer to:
  // https://github.com/graphql-nexus/nexus-future/issues/76
  const cmd = [...(opts.nodeArgs || []), runnerModulePath]
  const child = fork(cmd[0], cmd.slice(1), {
    cwd: process.cwd(),
    silent: true,
    env: {
      ...process.env,
      NEXUS_FUTURE_EVAL: opts.eval.code,
      NEXUS_FUTURE_EVAL_FILENAME: opts.eval.fileName,
      ...saveDataForChildProcess(opts.layout),
    },
  }) as Process

  // stdout & stderr are guaranteed becuase we do not permit fork stdio to be
  // configured with anything else than `pipe`.
  //
  child.stdout!.on('data', chunk => {
    opts.onEvent({ event: 'logging', data: chunk.toString() })
  })

  child.stderr!.on('data', chunk => {
    opts.onEvent?.({ event: 'logging', data: chunk.toString() })
  })

  // TODO We have removed this code since switching to chokidar. What is the
  // tradeoff exactly that we are making by no longer using this logic?
  //
  // const compileReqWatcher = filewatcher({ forcePolling: opts.poll })
  // let currentCompilePath: string
  // fs.writeFileSync(compiler.getCompileReqFilePath(), '')
  // compileReqWatcher.add(compiler.getCompileReqFilePath())
  // compileReqWatcher.on('change', function(file: string) {
  //   log('compileReqWatcher event change %s', file)
  //   fs.readFile(file, 'utf-8', function(err, data) {
  //     if (err) {
  //       console.error('error reading compile request file', err)
  //       return
  //     }
  //     const [compile, compiledPath] = data.split('\n')
  //     if (currentCompilePath === compiledPath) {
  //       return
  //     }
  //     currentCompilePath = compiledPath
  //     if (compiledPath) {
  //       compiler.compile({
  //         compile,
  //         compiledPath,
  //         callbacks: opts.callbacks ?? {},
  //       })
  //     }
  //   })
  // })

  child.on('exit', (code, signal) => {
    log('runner exiting')
    if (code === null) {
      log('runner did not exit on its own accord')
    } else {
      log('runner exited on its own accord with exit code %s', code)
    }

    if (signal === null) {
      log('runner did NOT receive a signal causing this exit')
    } else {
      log('runner received signal "%s" which caused this exit', signal)
    }

    // TODO is it possible for multiple exit event triggers?
    if (child.exited) return
    if (!child.respawn) {
      process.exit(code ?? 1)
    }
    child.exited = true
  })

  if (cfg.respawn) {
    child.respawn = true
  }

  if (compiler.tsConfigPath) {
    watcher.addSilently(compiler.tsConfigPath)
  }

  // TODO See above LOC ~238
  // ipc.on(
  //   child,
  //   'compile',
  //   (message: { compiledPath: string; compile: string }) => {
  //     log('got runner message "compile" %s', message)
  //     if (
  //       !message.compiledPath ||
  //       currentCompilePath === message.compiledPath
  //     ) {
  //       return
  //     }
  //     currentCompilePath = message.compiledPath
  //     ;(message as any).callbacks = opts.callbacks
  //     compiler.compile({ ...message, callbacks: opts.callbacks ?? {} })
  //   }
  // )

  // Listen for `required` messages and watch the required file.
  ipc.on(child, 'required', function(message) {
    // This log is commented out because it is very noisey if e.g. node_modules
    // are being watched––and not very interesting
    // log('got runner message "required" %s', message)
    const isIgnored =
      cfg.ignore.some(isPrefixOf(message.required)) ||
      cfg.ignore.some(isRegExpMatch(message.required))

    if (
      !isIgnored &&
      (cfg.deps === -1 || getLevel(message.required) <= cfg.deps)
    ) {
      watcher.addSilently(message.required)
    }
  })

  // Upon errors, display a notification and tell the child to exit.
  ipc.on(child, 'error', function(m: any) {
    console.error(m.stack)
    callbacks?.onError?.(m.willTerminate)
  })

  // TODO: Resuming watcher on this signal can lead to performance issues
  ipc.on(child, SERVER_READY_SIGNAL, () => {
    log('got runner signal "%s"', SERVER_READY_SIGNAL)
    /**
     * Watcher is resumed once the child sent a message saying it's ready to be restarted
     * This prevents the runner to be run several times thus leading to an EPIPE error
     */
    watcher.resume()
    opts.onEvent({ event: SERVER_READY_SIGNAL })
  })

  compiler.writeReadyFile()

  return child
}

function createPathMatcher(params: {
  toMatch?: string[]
  toIgnore?: string[]
}): (files: string | string[]) => boolean {
  const toAllow = params?.toMatch ?? []
  const toIgnore = params?.toIgnore?.map(pattern => '!' + pattern) ?? []
  const matchers = [...toAllow, ...toIgnore]

  return anymatch(matchers)
}
