// ESLint 9 扁平配置（flat config）：TypeScript + React。
//
// ESLint 9 不再读 `.eslintrc.*`，必须用本文件。规则选型原则：
//   - `@typescript-eslint/no-explicit-any` 设为 error —— 本项目约定不用 `any`
//   - `eslint-config-prettier` 放在数组最后，关闭所有与 Prettier 冲突的格式化规则
//     （本项目目前没有接入 Prettier，但格式化规则本就不该由 ESLint 管，交给
//     格式化工具是更合理的默认状态，将来接入 Prettier 也不用回头改这份配置）
//   - `eslint-plugin-react-hooks` 只取 `rules-of-hooks` / `exhaustive-deps` 两条
//     传统规则，不用它 v7 起自带的 "recommended"——那一整套是配合 React Compiler
//     设计的强 purity/immutability 规则集，会跟本项目大量刻意为之的性能写法冲突
//     （Timeline.tsx 用 ref 在渲染期间镜像 state 以避免重渲、命令式 DOM 更新等，
//     这些都是文件头注释里写明的设计取舍，不是要修的问题）

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  { ignores: ['dist/**', 'src/api/schema.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // TS 已经做类型检查，且用不到旧版 React 的 defaultProps 机制
      'react/prop-types': 'off',
      // 全角空格（U+3000）在本项目里是有意使用的中日文排版分隔符
      // （kana.ts 的假名归一化正则要匹配它，Timeline.tsx 的提示文案用模板字符串
      // 分段），跳过正则字面量与模板字符串里的检查，而不是逐处改写成半角空格
      'no-irregular-whitespace': ['error', { skipRegExps: true, skipTemplates: true }],
    },
  },
  prettier,
)
