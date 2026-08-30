import type { ValidationError } from '@nestjs/common';

import { badRequest } from './api-error';

/**
 * A rejected form body, said the way every other refusal is said.
 *
 * `ValidationPipe` answers with Nest's own shape: `code: "Bad Request"` and a
 * `message` that is an ARRAY of English sentences —
 *
 *     ["email must be an email",
 *      "password must be longer than or equal to 8 characters"]
 *
 * Nothing in the `errors` namespace matches `Bad Request`, so the client falls
 * through to the server text: English on an Arabic screen, and an array where a
 * string was expected, which React renders by concatenating the sentences into
 * one run-on line. It is the same failure as reading `data.message` one level
 * too shallow (CLAUDE.md rule 9) wearing a different hat — the API explains
 * itself carefully and the explanation reaches nobody.
 *
 * So validation gets a code like everything else. The English sentences are
 * kept as the message, because that is what the logs record and what a client
 * that has never heard the code falls back to; the field names travel as a
 * parameter so the translation can name them.
 *
 * Per-field wording in the reader's language is the form's job, not the API's.
 * A form that only learns "password too short" after a round trip is a slow
 * form, and the client already knows the rule.
 */
export function validationRefusal(errors: ValidationError[]) {
  const fields = flatten(errors);
  const english = errors
    .flatMap((e) => sentences(e))
    .join('; ');

  return badRequest(
    'VALIDATION_FAILED',
    english || 'Some of the values sent are not valid.',
    { fields: fields.join(', ') },
  );
}

/** Property paths, including nested ones like `items.0.quantity`. */
function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    const children = e.children?.length ? flatten(e.children, path) : [];
    return e.constraints ? [path, ...children] : children;
  });
}

function sentences(error: ValidationError): string[] {
  const own = error.constraints ? Object.values(error.constraints) : [];
  const nested = error.children?.length ? error.children.flatMap(sentences) : [];
  return [...own, ...nested];
}
