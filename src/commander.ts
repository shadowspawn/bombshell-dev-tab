import * as zsh from './zsh';
import * as bash from './bash';
import * as fish from './fish';
import * as powershell from './powershell';
import type { Command as CommanderCommand } from 'commander';
import t, { type RootCommand } from './t';

// rawArgs is available on the root command, but is not documented in the TypesScript types.
interface CommandWithRawArgs extends CommanderCommand {
  rawArgs: string[];
}

const execPath = process.execPath;
const processArgs = process.argv.slice(1);
const quotedExecPath = quoteIfNeeded(execPath);
const quotedProcessArgs = processArgs.map(quoteIfNeeded);
const quotedProcessExecArgs = process.execArgv.map(quoteIfNeeded);

const x = `${quotedExecPath} ${quotedProcessExecArgs.join(' ')} ${quotedProcessArgs[0]}`;

function quoteIfNeeded(path: string): string {
  return path.includes(' ') ? `'${path}'` : path;
}

export default function tab(instance: CommanderCommand): RootCommand {
  // The `complete` is overloaded. It performs as `complete <shell>` for the cli user,
  // but is called as `complete -- [args]` as the completion handler. It would be cleaner to separate these into two commands,
  // but stick with the standard @bomb.sh/tab pattern for consistency with other implementations and documentation.
  instance
    .command('complete')
    // [sic] argument should be <shell>. Description formatted to match `Argument.choices()`.
    .argument('[shell]', `shell (choices: "zsh", "bash", "fish", "powershell")`)
    .allowExcessArguments(true) // Allow extra args for completion handler mode
    .description(`Generate shell completion scripts`)
    .action(async (shell, _options, cmd) => {
      // Work out how we are being called, by user or by script as completion handler.
      const rawArgs = (instance as CommandWithRawArgs).rawArgs;
      const completeIndex = rawArgs.indexOf('complete');
      const dashDashIndex = rawArgs.indexOf('--');

      if (
        completeIndex !== -1 &&
        dashDashIndex !== -1 &&
        dashDashIndex > completeIndex
      ) {
        t.parse(cmd.args);
        return;
      }

      // Use Commander to display error formamtted to match Commander missing argument error.
      if (shell === undefined) {
        instance.error(`missing required argument 'shell'`);
      }
      const programName = instance.name();
      switch (shell) {
        case 'zsh': {
          const script = zsh.generate(programName, x);
          console.log(script);
          break;
        }
        case 'bash': {
          const script = bash.generate(programName, x);
          console.log(script);
          break;
        }
        case 'fish': {
          const script = fish.generate(programName, x);
          console.log(script);
          break;
        }
        case 'powershell': {
          const script = powershell.generate(programName, x);
          console.log(script);
          break;
        }
        case 'debug': {
          // Debug mode to print all collected commands
          const commandMap = new Map<string, CommanderCommand>();
          collectCommands(instance, '', commandMap);
          console.log('Collected commands:');
          for (const [path, cmd] of commandMap.entries()) {
            console.log(
              `- ${path || '<root>'}: ${cmd.description() || 'No description'}`
            );
          }
          break;
        }
        default: {
          // Use Commander to display error formamtted to match `Argument.choices()` error message.
          instance.error(
            `command-argument value '${shell}' is invalid for argument 'shell'. Allowed choices are zsh, bash, fish, powershell.`
          );
        }
      }
    });

  // Process the root command, which now has a `complete` command.
  processRootCommand(instance);

  // Process all subcommands.
  processSubcommands(instance);
  // ToDo: add shells to complete command as choices.

  return t;
}

/**
 * Detect whether a commander option flag expects a value argument.
 * Options with `<value>` or `[value]` in their flags are value-taking.
 */
function optionTakesValue(flags: string): boolean {
  return flags.includes('<') || flags.includes('[');
}

/**
 * Register a commander option with the tab library, correctly setting
 * isBoolean based on whether the option takes a value.
 *
 * The tab Command.option() method infers isBoolean from the argument types:
 * - string arg → alias, isBoolean=true
 * - function arg → handler, isBoolean=false
 * So for value-taking options with an alias, we pass a no-op handler
 * and the alias separately to get isBoolean=false.
 */
function registerOption(
  tabCommand: {
    option: (
      value: string,
      description: string,
      handlerOrAlias?: ((...args: unknown[]) => void) | string,
      alias?: string
    ) => unknown;
  },
  flags: string,
  longFlag: string,
  description: string,
  shortFlag?: string
): void {
  const takesValue = optionTakesValue(flags);
  if (shortFlag) {
    if (takesValue) {
      // Pass a no-op handler to force isBoolean=false, with alias as 4th arg
      tabCommand.option(longFlag, description, () => {}, shortFlag);
    } else {
      tabCommand.option(longFlag, description, shortFlag);
    }
  } else {
    if (takesValue) {
      tabCommand.option(longFlag, description, () => {});
    } else {
      tabCommand.option(longFlag, description);
    }
  }
}

function processRootCommand(command: CommanderCommand): void {
  // Add root command options to the root t instance
  for (const option of command.options) {
    // Extract short flag from the name if it exists (e.g., "-c, --config" -> "c")
    const flags = option.flags;
    const shortFlag = flags.match(/^-([a-zA-Z]), --/)?.[1];
    const longFlag = flags.match(/--([a-zA-Z0-9-]+)/)?.[1];

    if (longFlag) {
      registerOption(t, flags, longFlag, option.description || '', shortFlag);
    }
  }
}

function processSubcommands(rootCommand: CommanderCommand): void {
  // Build a map of command paths
  const commandMap = new Map<string, CommanderCommand>();

  // Collect all commands with their full paths
  collectCommands(rootCommand, '', commandMap);

  // Process each command
  for (const [path, cmd] of commandMap.entries()) {
    if (path === '') continue; // Skip root command, already processed

    // Add command using t.ts API
    const command = t.command(path, cmd.description() || '');

    // Add command options
    for (const option of cmd.options) {
      // Extract short flag from the name if it exists (e.g., "-c, --config" -> "c")
      const flags = option.flags;
      const shortFlag = flags.match(/^-([a-zA-Z]), --/)?.[1];
      const longFlag = flags.match(/--([a-zA-Z0-9-]+)/)?.[1];

      if (longFlag) {
        registerOption(
          command,
          flags,
          longFlag,
          option.description || '',
          shortFlag
        );
      }
    }
  }
}

function collectCommands(
  command: CommanderCommand,
  parentPath: string,
  commandMap: Map<string, CommanderCommand>
): void {
  // Add this command to the map
  commandMap.set(parentPath, command);

  // Process subcommands
  for (const subcommand of command.commands) {
    // Skip the completion command
    //if (subcommand.name() === 'complete') continue;

    // Build the full path for this subcommand
    const subcommandPath = parentPath
      ? `${parentPath} ${subcommand.name()}`
      : subcommand.name();

    // Recursively collect subcommands
    collectCommands(subcommand, subcommandPath, commandMap);
  }
}
