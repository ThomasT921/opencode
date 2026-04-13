import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { Newtype } from "@/util/schema"

export class JobID extends Newtype<JobID>()("JobID", Schema.String) {
  static ascending(id?: string): JobID {
    return this.make(Identifier.ascending("job", id))
  }
}
