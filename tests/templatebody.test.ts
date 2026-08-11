import { describe, it, expect, beforeEach } from 'vitest';
import { createSqliteAdapter } from '../src/repo/adapters/SqliteAdapter';
import { MetaCloudProvider } from '../src/providers/MetaCloudProvider';
import { splitTemplateVars, buildBodyComponent } from '../src/providers/templateComponents';
import { TemplateParamsError } from '../src/providers/errors';
import type { Repo } from '../src/repo';
import type { Instance } from '../src/repo/types';

/**
 * Contagem de parâmetros do BODY (bug do 132000).
 *
 * O 132000 da Meta é erro de DIVERGÊNCIA de contagem: dispara com variável a
 * menos E com variável a mais. Até aqui, botão e header já validavam localmente;
 * o corpo era o único que ia "no escuro" e só descobria o erro quando a Meta
 * rejeitava — gastando uma chamada e devolvendo um código opaco.
 */

interface CapturedCall {
  url: string;
  body: Record<string, unknown>;
}
function makeFetch() {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const i = init as RequestInit;
    calls.push({ url: String(url), body: JSON.parse((i.body as string) ?? '{}') });
    return {
      ok: true,
      status: 200,
      json: async () => ({ messages: [{ id: 'wamid.ok' }] }),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Estrutura REAL do template aprovado nesta WABA. */
const REAL = [
  { type: 'HEADER', format: 'TEXT', text: 'Cadastro confirmado' },
  { type: 'BODY', text: 'Olá {{1}}, vaga de {{2}}. Grupo:\n\n{{3}}' },
  { type: 'FOOTER', text: 'Vendedor Mestre — Recrutamento' },
  {
    type: 'BUTTONS',
    buttons: [{ type: 'URL', text: 'Entrar no grupo', url: 'http://business.facebook.com/{{1}}' }],
  },
];

const bodyVarsDe = (vars: Record<string, string>) => splitTemplateVars(vars).bodyVars;

let repo: Repo;
let instance: Instance;

beforeEach(async () => {
  repo = createSqliteAdapter({ path: ':memory:' });
  await repo.migrate();
  instance = await repo.instances.create({
    name: 'Loja', provider_type: 'meta', phone_number_id: '109999888777', waba_id: null,
    token: 'TOKEN', verify_token: 'v', active: true, connection_status: 'connected',
  });
});

describe('buildBodyComponent — contagem contra os placeholders do template', () => {
  it('contagem correta monta os parâmetros na ORDEM posicional', () => {
    const comps = buildBodyComponent(
      REAL,
      bodyVarsDe({ '1': 'Rafael', '2': 'SDR', '3': 'https://chat.whatsapp.com/X' }),
      'confirmacao_cadastro_vaga_vm',
    );
    expect(comps).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Rafael' },
          { type: 'text', text: 'SDR' },
          { type: 'text', text: 'https://chat.whatsapp.com/X' },
        ],
      },
    ]);
  });

  it('a ordem dos parâmetros segue o NÚMERO do placeholder, não a ordem do objeto', () => {
    const comps = buildBodyComponent(
      REAL,
      bodyVarsDe({ '3': 'terceiro', '1': 'primeiro', '2': 'segundo' }),
      'tpl',
    );
    expect((comps[0].parameters as { text: string }[]).map((p) => p.text)).toEqual([
      'primeiro', 'segundo', 'terceiro',
    ]);
  });

  it('variável FALTANDO → TemplateParamsError dizendo qual', () => {
    expect(() => buildBodyComponent(REAL, bodyVarsDe({ '1': 'Rafael', '2': 'SDR' }), 'tpl'))
      .toThrow(TemplateParamsError);
    expect(() => buildBodyComponent(REAL, bodyVarsDe({ '1': 'Rafael', '2': 'SDR' }), 'tpl'))
      .toThrow(/faltou "3"/);
  });

  it('variável SOBRANDO → também falha (132000 é divergência, nos dois sentidos)', () => {
    const vars = { '1': 'a', '2': 'b', '3': 'c', '4': 'sobrando' };
    expect(() => buildBodyComponent(REAL, bodyVarsDe(vars), 'tpl')).toThrow(TemplateParamsError);
    expect(() => buildBodyComponent(REAL, bodyVarsDe(vars), 'tpl')).toThrow(/"4"/);
  });

  it('corpo sem variável + variável informada → falha', () => {
    const semVar = [{ type: 'BODY', text: 'Mensagem fixa, sem placeholder.' }];
    expect(() => buildBodyComponent(semVar, bodyVarsDe({ '1': 'x' }), 'tpl'))
      .toThrow(/não tem nenhuma variável/);
  });

  it('corpo sem variável e nada informado → nenhum component (não manda body vazio)', () => {
    const semVar = [{ type: 'BODY', text: 'Mensagem fixa.' }];
    expect(buildBodyComponent(semVar, bodyVarsDe({}), 'tpl')).toEqual([]);
  });

  it('placeholder REPETIDO conta como UM parâmetro', () => {
    // A Meta conta parâmetros distintos, não ocorrências no texto.
    const repetido = [{ type: 'BODY', text: 'Oi {{1}}, confirmando: {{1}} — certo, {{2}}?' }];
    const comps = buildBodyComponent(repetido, bodyVarsDe({ '1': 'Ana', '2': 'sim' }), 'tpl');
    expect((comps[0].parameters as unknown[]).length).toBe(2);
  });

  it('template NÃO sincronizado (sem components) não valida contagem', () => {
    // Mesmo critério já estabelecido para botão, header e idioma.
    const comps = buildBodyComponent(undefined, bodyVarsDe({ '1': 'a', '2': 'b' }), 'tpl');
    expect((comps[0].parameters as unknown[]).length).toBe(2);
    expect(() => buildBodyComponent(null, bodyVarsDe({ '9': 'x' }), 'tpl')).not.toThrow();
  });

  it('string VAZIA conta como informada (campanha sem dado de CRM não pode quebrar)', () => {
    // resolveVarSource devolve '' quando o contato não tem o campo; disparo em
    // produção já depende disso. Validar contagem não pode virar validação de
    // conteúdo por contrabando.
    const comps = buildBodyComponent(REAL, bodyVarsDe({ '1': 'Ana', '2': '', '3': 'link' }), 'tpl');
    expect((comps[0].parameters as { text: string }[])[1].text).toBe('');
  });

  it('variáveis de botão/header não contam como parâmetro de corpo', () => {
    // splitTemplateVars já separa; o corpo só enxerga as numéricas.
    const vars = { '1': 'a', '2': 'b', '3': 'c', button0: 'sufixo', header: 'H' };
    expect(() => buildBodyComponent(REAL, bodyVarsDe(vars), 'tpl')).not.toThrow();
  });
});

describe('sendTemplate — falha ANTES de gastar chamada na Graph API', () => {
  /**
   * sendTemplate declara Promise mas a validação lança SÍNCRONO (vale para
   * botão e header também, desde antes). Em produção isso é inofensivo:
   * sendViaProvider chama dentro de try/await. Aqui capturamos das duas formas
   * para o teste medir o que importa — que nenhuma requisição saiu.
   */
  const capturar = async (fn: () => Promise<unknown>): Promise<unknown> => {
    try {
      await fn();
      return null;
    } catch (e) {
      return e;
    }
  };

  it('variável faltando não chega a chamar a Meta', async () => {
    const { fetchImpl, calls } = makeFetch();
    const provider = new MetaCloudProvider({ fetchImpl });
    const err = await capturar(() =>
      provider.sendTemplate(
        instance,
        '5511999998888',
        { name: 'confirmacao_cadastro_vaga_vm', language: 'pt_BR', components: REAL },
        { '1': 'Rafael', button0: 'X' },
      ),
    );
    expect(err).toBeInstanceOf(TemplateParamsError);
    expect(calls).toEqual([]); // nenhuma requisição saiu
  });

  it('variável sobrando não chega a chamar a Meta', async () => {
    const { fetchImpl, calls } = makeFetch();
    const provider = new MetaCloudProvider({ fetchImpl });
    const err = await capturar(() =>
      provider.sendTemplate(
        instance,
        '5511999998888',
        { name: 'tpl', language: 'pt_BR', components: [{ type: 'BODY', text: 'Oi {{1}}' }] },
        { '1': 'a', '2': 'b' },
      ),
    );
    expect(err).toBeInstanceOf(TemplateParamsError);
    expect(calls).toEqual([]);
  });

  it('ANTI-REGRESSÃO: o template real segue montando o payload idêntico', async () => {
    const { fetchImpl, calls } = makeFetch();
    const provider = new MetaCloudProvider({ fetchImpl });
    await provider.sendTemplate(
      instance,
      '5521999243888',
      { name: 'confirmacao_cadastro_vaga_vm', language: 'pt_BR', components: REAL },
      {
        '1': 'Rafael Cruz',
        '2': 'SDR',
        '3': 'https://chat.whatsapp.com/KEQaSkJEpUK8e1XaOFZIoR',
        button0: 'KEQaSkJEpUK8e1XaOFZIoR',
      },
    );

    expect(calls.length).toBe(1);
    const tpl = (calls[0].body as { template: Record<string, unknown> }).template;
    expect(tpl.name).toBe('confirmacao_cadastro_vaga_vm');
    expect(tpl.language).toEqual({ code: 'pt_BR' });
    // Corpo com os 3 parâmetros na ordem + o component de botão preservado.
    expect(tpl.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Rafael Cruz' },
          { type: 'text', text: 'SDR' },
          { type: 'text', text: 'https://chat.whatsapp.com/KEQaSkJEpUK8e1XaOFZIoR' },
        ],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: 'KEQaSkJEpUK8e1XaOFZIoR' }],
      },
    ]);
  });
});
