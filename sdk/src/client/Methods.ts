import { charge as charge_ } from './Charge.js'

export function xrpl(parameters: xrpl.Parameters): ReturnType<typeof charge_> {
  return charge_(parameters)
}

export namespace xrpl {
  export type Parameters = charge_.Parameters
  export const charge = charge_
}
