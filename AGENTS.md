# Versioning Guidelines

When making changes to this application, please adhere to the following semantic versioning rules:

1. **Current Version**: The version is tracked in `package.json` under the `"version"` field.
2. **Small Changes**: For minor bug fixes, UI tweaks, or small adjustments, increment the **patch** version (the 3rd digit). Example: `1.0.0` -> `1.0.1`.
3. **Large Changes**: For new features or significant updates, increment the **minor** version (the 2nd digit) and reset the patch version to 0. Example: `1.0.1` -> `1.1.0`.
4. **Major Overhauls**: For complete redesigns, architectural changes, or major overhauls, increment the **major** version (the 1st digit) and reset the minor and patch versions to 0. Example: `1.1.0` -> `2.0.0`.

Always update `package.json` when completing a task that modifies the application. The UI automatically reads the version from `package.json` and displays it in the header.
