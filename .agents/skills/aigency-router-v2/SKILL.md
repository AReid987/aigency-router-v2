```markdown
# aigency-router-v2 Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches you the development conventions and workflows used in the `aigency-router-v2` Python codebase. You'll learn about file naming, import/export styles, commit patterns, and how to write and run tests based on observed repository practices.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `routerCore.py`, `userHandler.py`

### Import Style
- Prefer **relative imports** within modules.
  - Example:
    ```python
    from .utils import parseRequest
    from .models import UserModel
    ```

### Export Style
- Mixed export styles are used. Functions, classes, and variables may be exported directly or via `__all__`.
  - Example:
    ```python
    # Direct export
    def handleRequest(req):
        ...
    
    # Using __all__
    __all__ = ['handleRequest', 'UserModel']
    ```

### Commit Patterns
- Commits often use the `feat` prefix for new features.
- Commit messages average 72 characters in length.
  - Example: `feat: add support for dynamic route registration`

## Workflows

### Adding a New Feature
**Trigger:** When you need to implement a new capability.
**Command:** `/add-feature`

1. Create a new file using camelCase if needed.
2. Write your code, using relative imports for internal modules.
3. Export your main functions/classes as needed.
4. Write corresponding tests in a `*.test.*` file.
5. Commit your changes with a message starting with `feat:`.
   - Example: `feat: implement user authentication middleware`

### Writing and Running Tests
**Trigger:** When you add or modify functionality.
**Command:** `/run-tests`

1. Create or update test files matching the `*.test.*` pattern.
   - Example: `routerCore.test.py`
2. Use the project's preferred (unknown) testing framework.
3. Run all tests to ensure correctness.

### Code Review and Refactoring
**Trigger:** Before merging or after feedback.
**Command:** `/code-review`

1. Check that all file names use camelCase.
2. Ensure all imports are relative within the module.
3. Confirm exports are clear and consistent.
4. Make sure all new code is covered by tests.

## Testing Patterns

- Test files follow the `*.test.*` naming convention.
  - Example: `userHandler.test.py`
- The specific testing framework is not detected; follow existing patterns in the repository.
- Place tests close to the code they test for easier maintenance.

## Commands
| Command         | Purpose                                    |
|-----------------|--------------------------------------------|
| /add-feature    | Scaffold and commit a new feature          |
| /run-tests      | Run all tests in the codebase              |
| /code-review    | Review code for style and test coverage    |
```