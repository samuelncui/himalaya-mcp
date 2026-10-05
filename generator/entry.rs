// Included only in a temporary upstream source tree under build/.
// This entry point never calls Himalaya's command executor.
use clap::{Arg, ArgMatches, Command};
use serde_json::{Value, json};
use std::{
    any::TypeId,
    collections::HashSet,
    io::{BufRead, Write},
    path::PathBuf,
};

fn value_type(arg: &Arg) -> &'static str {
    let parser_type = arg.get_value_parser().type_id();
    if !arg.get_action().takes_values() || parser_type == TypeId::of::<bool>() {
        return "boolean";
    }
    if parser_type == TypeId::of::<PathBuf>() {
        return "path";
    }
    if [
        TypeId::of::<u8>(),
        TypeId::of::<u16>(),
        TypeId::of::<u32>(),
        TypeId::of::<u64>(),
        TypeId::of::<u128>(),
        TypeId::of::<usize>(),
        TypeId::of::<i8>(),
        TypeId::of::<i16>(),
        TypeId::of::<i32>(),
        TypeId::of::<i64>(),
        TypeId::of::<i128>(),
        TypeId::of::<isize>(),
    ]
    .iter()
    .any(|type_id| parser_type == *type_id)
    {
        return "integer";
    }
    if parser_type == TypeId::of::<f32>() || parser_type == TypeId::of::<f64>() {
        return "number";
    }
    "string"
}

fn describe_arg(arg: &Arg) -> Value {
    let range = arg
        .get_num_args()
        .expect("built arguments have a value range");
    let maximum = range.max_values();
    let choices: Vec<String> = arg
        .get_possible_values()
        .iter()
        .flat_map(|value| {
            value
                .get_name_and_aliases()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    json!({
        "id": arg.get_id().as_str(),
        "long": arg.get_long(),
        "short": arg.get_short().map(|value| value.to_string()),
        "aliases": arg.get_all_aliases().unwrap_or_default(),
        "shortAliases": arg.get_all_short_aliases().unwrap_or_default().iter().map(char::to_string).collect::<Vec<_>>(),
        "action": format!("{:?}", arg.get_action()),
        "index": arg.get_index(),
        "minValues": range.min_values(),
        "maxValues": if maximum == usize::MAX { None } else { Some(maximum) },
        "valueDelimiter": arg.get_value_delimiter().map(|value| value.to_string()),
        "requireEquals": arg.is_require_equals_set(),
        "valueTerminator": arg.get_value_terminator().map(|value| value.as_str()),
        "last": arg.is_last_set(),
        "trailing": arg.is_trailing_var_arg_set(),
        "allowHyphenValues": arg.is_allow_hyphen_values_set(),
        "global": arg.is_global_set(),
        "required": arg.is_required_set(),
        "hidden": arg.is_hide_set(),
        "defaultValues": arg.get_default_values().iter().map(|value| value.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "env": arg.get_env().map(|value| value.to_string_lossy().into_owned()),
        "help": arg.get_long_help().or_else(|| arg.get_help()).map(ToString::to_string).unwrap_or_default(),
        "valueType": value_type(arg),
        "valueChoices": choices,
    })
}

fn visit(
    command: &Command,
    path: Vec<String>,
    declared: &HashSet<Vec<String>>,
    automatic_help: bool,
    commands: &mut Vec<Value>,
) {
    assert!(
        declared.contains(&path) || automatic_help,
        "Undiscovered business command: {}",
        path.join(" ")
    );
    let mut rendered = command.clone();
    commands.push(json!({
        "path": path,
        "aliases": command.get_all_aliases().collect::<Vec<_>>(),
        "hidden": command.is_hide_set(),
        "about": command.get_long_about().or_else(|| command.get_about()).map(ToString::to_string).unwrap_or_default(),
        "help": rendered.render_long_help().to_string(),
        "args": command.get_arguments().map(describe_arg).collect::<Vec<_>>(),
        "frameworkGenerated": !declared.contains(&path),
        "runnable": declared.contains(&path) && !command.is_subcommand_required_set(),
    }));
    for child in command.get_subcommands() {
        let mut child_path = path.clone();
        child_path.push(child.get_name().to_owned());
        let child_is_automatic_help = automatic_help
            || (!command.is_disable_help_subcommand_set() && child.get_name() == "help");
        visit(
            child,
            child_path,
            declared,
            child_is_automatic_help,
            commands,
        );
    }
}

fn command() -> Command {
    let mut command = <crate::cli::Cli as clap::CommandFactory>::command();
    command = command.color(clap::ColorChoice::Never);
    command.build();
    command
}

fn collect_paths(command: &Command, path: Vec<String>, paths: &mut HashSet<Vec<String>>) {
    paths.insert(path.clone());
    for child in command.get_subcommands() {
        let mut next = path.clone();
        next.push(child.get_name().to_owned());
        collect_paths(child, next, paths);
    }
}

fn declared_paths(command: Command) -> HashSet<Vec<String>> {
    // Build deferred business registrations without Clap's automatic Help copies.
    // This global setting propagates to children; explicitly registered Help
    // commands remain ordinary business commands, regardless of their name.
    let mut command = command.disable_help_subcommand(true);
    command.build();
    let mut paths = HashSet::new();
    collect_paths(&command, Vec::new(), &mut paths);
    paths
}

fn describe() -> Value {
    let mut features: Vec<_> = env!("CARGO_FEATURES")
        .split_whitespace()
        .map(|value| value.trim_start_matches('+'))
        .collect();
    features.sort_unstable();
    let mut commands = Vec::new();
    let declared = declared_paths(<crate::cli::Cli as clap::CommandFactory>::command());
    visit(&command(), Vec::new(), &declared, false, &mut commands);
    json!({
        "schemaVersion": 1,
        "native": {
            "name": env!("CARGO_PKG_NAME"),
            "version": env!("CARGO_PKG_VERSION"),
            "revision": env!("GIT_REV"),
            "features": features,
        },
        "commands": commands,
    })
}

fn raw_values(matches: &ArgMatches, arg: &Arg) -> Option<Value> {
    let id = arg.get_id().as_str();
    let source = matches.value_source(id)?;
    let values: Vec<String> = matches
        .get_raw(id)?
        .map(|value| value.to_string_lossy().into_owned())
        .collect();
    let occurrences: Vec<Vec<String>> = matches
        .get_raw_occurrences(id)
        .map(|groups| {
            groups
                .map(|group| {
                    group
                        .map(|value| value.to_string_lossy().into_owned())
                        .collect()
                })
                .collect()
        })
        .unwrap_or_default();
    Some(json!({"source": format!("{source:?}"), "values": values, "occurrences": occurrences}))
}

fn parse(request: Value) -> Value {
    let Some(arguments) = request.get("argv").and_then(Value::as_array) else {
        return json!({"ok": false, "errorKind": "Input", "error": "argv must be an array of strings"});
    };
    let Some(arguments) = arguments
        .iter()
        .map(Value::as_str)
        .collect::<Option<Vec<_>>>()
    else {
        return json!({"ok": false, "errorKind": "Input", "error": "argv must contain only strings"});
    };
    let command = command();
    let mut argv = vec!["himalaya"];
    argv.extend(arguments);
    let matches = match command.clone().try_get_matches_from(argv) {
        Ok(matches) => matches,
        Err(error) => {
            return json!({"ok": false, "errorKind": format!("{:?}", error.kind()), "error": error.to_string()});
        }
    };
    let mut path = Vec::new();
    let mut leaf_command = &command;
    let mut leaf_matches = &matches;
    while let Some((name, child_matches)) = leaf_matches.subcommand() {
        path.push(name.to_owned());
        leaf_command = leaf_command
            .find_subcommand(name)
            .expect("Clap parsed a registered command");
        leaf_matches = child_matches;
    }
    let mut args = serde_json::Map::new();
    for arg in leaf_command.get_arguments() {
        if let Some(values) = raw_values(leaf_matches, arg) {
            args.insert(arg.get_id().to_string(), values);
        }
    }
    json!({"ok": true, "path": path, "args": args})
}

pub fn entry() {
    match std::env::args().nth(1).as_deref() {
        Some("describe") => println!(
            "{}",
            serde_json::to_string_pretty(&describe()).expect("serialize catalog")
        ),
        Some("parse") => {
            let stdin = std::io::stdin();
            let stdout = std::io::stdout();
            let mut stdout = stdout.lock();
            for line in stdin.lock().lines() {
                let result = line
                    .map_err(|error| error.to_string())
                    .and_then(|line| {
                        serde_json::from_str::<Value>(&line).map_err(|error| error.to_string())
                    })
                    .map(parse)
                    .unwrap_or_else(
                        |error| json!({"ok": false, "errorKind": "Input", "error": error}),
                    );
                writeln!(stdout, "{result}").expect("write parser result");
                stdout.flush().expect("flush parser result");
            }
        }
        _ => {
            eprintln!("Usage: generated CI helper <describe|parse>");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deferred_business_commands_are_discovered() {
        fn factory() -> Command {
            Command::new("synthetic").defer(|command| {
                command.subcommand(
                    Command::new("later")
                        .defer(|command| command.subcommand(Command::new("nested").hide(true))),
                )
            })
        }
        let declared = declared_paths(factory());
        assert!(declared.contains(&vec!["later".to_owned()]));
        assert!(declared.contains(&vec!["later".to_owned(), "nested".to_owned()]));
        assert!(!declared.contains(&vec!["help".to_owned()]));
        assert!(!declared.contains(&vec!["later".to_owned(), "help".to_owned()]));

        let mut native = factory();
        native.build();
        let mut catalog = Vec::new();
        visit(&native, Vec::new(), &declared, false, &mut catalog);
        let deferred = catalog
            .iter()
            .find(|value| value["path"] == json!(["later", "nested"]))
            .unwrap();
        assert_eq!(deferred["frameworkGenerated"], false);
        assert_eq!(deferred["runnable"], true);
        assert_eq!(deferred["hidden"], true);
        let generated = catalog
            .iter()
            .find(|value| value["path"] == json!(["help"]))
            .unwrap();
        assert_eq!(generated["frameworkGenerated"], true);
        assert_eq!(generated["runnable"], false);
        native
            .try_get_matches_from(["synthetic", "later", "nested"])
            .unwrap();
    }

    #[test]
    #[should_panic(expected = "Undiscovered business command: conditional")]
    fn inconsistent_deferred_discovery_fails_closed() {
        fn factory() -> Command {
            Command::new("synthetic").defer(|command| {
                if command.is_disable_help_subcommand_set() {
                    command
                } else {
                    command.subcommand(Command::new("conditional"))
                }
            })
        }
        let declared = declared_paths(factory());
        let mut native = factory();
        native.build();
        let mut catalog = Vec::new();
        visit(&native, Vec::new(), &declared, false, &mut catalog);
    }

    #[test]
    fn explicit_business_help_is_discovered() {
        fn factory() -> Command {
            Command::new("synthetic")
                .disable_help_subcommand(true)
                .subcommand(Command::new("help").arg(Arg::new("value").long("value")))
        }
        let declared = declared_paths(factory());
        assert!(declared.contains(&vec!["help".to_owned()]));
        let mut native = factory();
        native.build();
        let mut catalog = Vec::new();
        visit(&native, Vec::new(), &declared, false, &mut catalog);
        let business = catalog
            .iter()
            .find(|value| value["path"] == json!(["help"]))
            .unwrap();
        assert_eq!(business["frameworkGenerated"], false);
        assert_eq!(business["runnable"], true);
        let matches = native
            .try_get_matches_from(["synthetic", "help", "--value=test"])
            .unwrap();
        assert_eq!(
            matches
                .subcommand_matches("help")
                .unwrap()
                .get_one::<String>("value")
                .unwrap(),
            "test"
        );
    }
}
