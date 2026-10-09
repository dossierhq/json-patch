export default {
  plugins: ["typescript", "unicorn", "oxc", "vitest", "import"],
  jsPlugins: ["eslint-plugin-turbo"],
  options: { reportUnusedDisableDirectives: "error", typeAware: true },
  rules: {
    "eslint/no-unused-vars": [
      "warn",
      {
        vars: "local",
        args: "after-used",
        ignoreRestSiblings: true,
        varsIgnorePattern: "^_",
        argsIgnorePattern: "^_",
      },
    ],
    "eslint/no-void": "warn",
    "typescript/consistent-type-imports": "warn",
    "import/consistent-type-specifier-style": ["error", "prefer-top-level-if-only-type-imports"],
    // No ignoreVoid: `no-void` forbids the `void expr` statement outright, so there is
    // no `void`-prefixed escape hatch to honor. Intentional fire-and-forget calls are
    // marked with an explicit `oxlint-disable-next-line` directive instead.
    "typescript/no-floating-promises": "warn",
    "turbo/no-undeclared-env-vars": "error",
    "typescript/require-await": "error",
    "typescript/return-await": ["error", "error-handling-correctness-only"],
    "typescript/no-unsafe-argument": "error",
    "typescript/no-unsafe-assignment": "error",
    "typescript/no-unsafe-call": "error",
    "typescript/no-unsafe-member-access": "error",
    "typescript/no-unsafe-return": "error",
    "typescript/no-misused-promises": "error",
    // A `default` does not cover a union: a new member (a schema kind, an event type)
    // has to be placed in every switch over it.
    "typescript/switch-exhaustiveness-check": [
      "error",
      { considerDefaultExhaustiveForUnions: false },
    ],
    "typescript/no-explicit-any": "error",
    "typescript/only-throw-error": "error",
    "vitest/require-mock-type-parameters": "off",
    "typescript/no-unnecessary-condition": "error",
    "typescript/no-non-null-assertion": "error",
    "vitest/no-conditional-expect": "error",
    "jest/require-to-throw-message": "off",
  },
  overrides: [
    {
      // A test states what it expects, so `!` there is an assertion, not a guess.
      files: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.bench.ts",
        "**/test/**",
        "**/tests/**",
      ],
      rules: { "typescript/no-non-null-assertion": "off" },
    },
  ],
  ignorePatterns: ["dist/", "node_modules/"],
};
