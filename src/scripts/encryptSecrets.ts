import { loadEnv } from '../config';
import { getRepo } from '../repo';

/* eslint-disable no-console */

/**
 * `npm run encrypt-secrets` — backfill da criptografia em repouso (P6.1 / L1).
 *
 * Cifra os segredos que ainda estão em TEXTO CLARO no banco:
 *   - instances.token / instances.verify_token  (credenciais da Meta)
 *   - baileys_auth.value                        (sessão do WhatsApp)
 *
 * ORDEM: roda DEPOIS do deploy do código, nunca antes. A leitura é tolerante
 * (valor sem o prefixo `enc:` é lido como texto claro), então o sistema
 * funciona nos dois estados e não há janela de indisponibilidade.
 *
 * IDEMPOTENTE: linha já cifrada é contada em "já cifradas" e não é tocada —
 * rodar duas vezes não gera cifra sobre cifra.
 */
async function main(): Promise<void> {
  const env = loadEnv();

  // FALHA ALTA: sem chave, o backfill "passaria" gravando texto claro por cima
  // de texto claro e reportando sucesso — a pior forma de não criptografar.
  if (!env.SECRETS_ENCRYPTION_KEY) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY não está definida. Sem ela não há o que cifrar — ' +
        'defina a MESMA chave usada pela Vercel e pelo worker e rode de novo.',
    );
  }

  const repo = getRepo();
  console.log(`Banco: ${repo.driver} @ ${repo.target}`);

  const r = await repo.maintenance.backfillSecretEncryption();
  console.log('Backfill concluído:');
  console.log(`  instances.token cifrados        : ${r.instanceTokens}`);
  console.log(`  instances.verify_token cifrados : ${r.instanceVerifyTokens}`);
  console.log(`  baileys_auth.value cifrados     : ${r.baileysAuthValues}`);
  console.log(`  já cifradas (ignoradas)         : ${r.skipped}`);

  await repo.close();
  console.log(
    'Confira o painel (as instâncias devem seguir enviando) e o worker ' +
      '(a sessão Baileys deve seguir conectada). Se algo falhar com ' +
      '"SecretDecryptError", a chave do processo é diferente da que gravou.',
  );
}

main().catch((err) => {
  console.error('FALHA no backfill de criptografia:');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
