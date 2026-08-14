import { channel as channel_ } from './Channel.js'

export function xrpl(parameters: xrpl.Parameters): ReturnType<typeof channel_> {
  return channel_(parameters)
}

export namespace xrpl {
  export type Parameters = channel_.Parameters
  export const channel = channel_
}
