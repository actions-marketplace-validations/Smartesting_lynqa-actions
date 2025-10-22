import type { Config } from 'jest'

const config: Config = {
  transform: {
    '^.+\\.ts$': 'ts-jest'
  },
  moduleFileExtensions: ['js', 'ts'],
  testEnvironment: 'node'
}

export default config
