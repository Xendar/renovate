import upath from 'upath';
import { ReleaseResult, getPkgReleases } from '..';
import * as httpMock from '../../../test/http-mock';
import { loadFixture } from '../../../test/util';
import * as hostRules from '../../util/host-rules';
import { id as versioning } from '../../versioning/maven';
import { ClojureDatasource } from '.';

const baseUrl = 'https://clojars.org/repo';
const baseUrlCustom = 'https://custom.registry.renovatebot.com';

interface MockOpts {
  dep?: string;
  base?: string;
  meta?: string | null;
  pom?: string | null;
  latest?: string;
  jars?: Record<string, number> | null;
}

function mockGenericPackage(opts: MockOpts = {}) {
  const {
    dep = 'org.example:package',
    base = baseUrl,
    latest = '2.0.0',
  } = opts;
  const meta =
    opts.meta === undefined
      ? loadFixture('metadata.xml', upath.join('..', 'maven'))
      : opts.meta;
  const pom =
    opts.pom === undefined
      ? loadFixture('pom.xml', upath.join('..', 'maven'))
      : opts.pom;
  const jars =
    opts.jars === undefined
      ? {
          '1.0.0': 200,
          '1.0.1': 404,
          '1.0.2': 500,
          '2.0.0': 200,
        }
      : opts.jars;

  const scope = httpMock.scope(base);

  const [group, artifact] = dep.split(':');
  const packagePath = `${group.replace(/\./g, '/')}/${artifact}`;

  if (meta) {
    scope.get(`/${packagePath}/maven-metadata.xml`).reply(200, meta);
  }

  if (pom) {
    scope
      .get(`/${packagePath}/${latest}/${artifact}-${latest}.pom`)
      .reply(200, pom);
  }

  if (jars) {
    Object.entries(jars).forEach(([version, status]) => {
      const [major, minor, patch] = version
        .split('.')
        .map((x) => parseInt(x, 10))
        .map((x) => (x < 10 ? `0${x}` : `${x}`));
      const timestamp = `2020-01-01T${major}:${minor}:${patch}.000Z`;
      scope
        .head(`/${packagePath}/${version}/${artifact}-${version}.pom`)
        .reply(status, '', { 'Last-Modified': timestamp });
    });
  }
}
function get(
  depName = 'org.example:package',
  ...registryUrls: string[]
): Promise<ReleaseResult | null> {
  const conf = { versioning, datasource: ClojureDatasource.id, depName };
  return getPkgReleases(registryUrls ? { ...conf, registryUrls } : conf);
}

describe('datasource/clojure/index', () => {
  beforeEach(() => {
    hostRules.add({
      hostType: ClojureDatasource.id,
      matchHost: 'custom.registry.renovatebot.com',
      token: '123test',
    });
    jest.resetAllMocks();
  });

  afterEach(() => {
    hostRules.clear();
    delete process.env.RENOVATE_EXPERIMENTAL_NO_MAVEN_POM_CHECK;
  });

  it('returns releases from custom repository', async () => {
    mockGenericPackage({ base: baseUrlCustom });

    const res = await get('org.example:package', baseUrlCustom);

    expect(res).toMatchSnapshot();
    expect(httpMock.getTrace()).toMatchSnapshot();
  });

  it('collects releases from all registry urls', async () => {
    mockGenericPackage();
    mockGenericPackage({
      base: baseUrlCustom,
      meta: loadFixture('metadata-extra.xml', upath.join('..', 'maven')),
      latest: '3.0.0',
      jars: { '3.0.0': 200 },
    });

    const { releases } = await get(
      'org.example:package',
      baseUrl,
      baseUrlCustom
    );

    expect(releases).toMatchObject([
      { version: '1.0.0' },
      { version: '2.0.0' },
      { version: '3.0.0' },
    ]);
    expect(httpMock.getTrace()).toMatchSnapshot();
  });

  it('falls back to next registry url', async () => {
    mockGenericPackage();
    httpMock
      .scope('https://failed_repo')
      .get('/org/example/package/maven-metadata.xml')
      .reply(404, null);
    httpMock
      .scope('https://unauthorized_repo')
      .get('/org/example/package/maven-metadata.xml')
      .reply(403, null);
    httpMock
      .scope('https://empty_repo')
      .get('/org/example/package/maven-metadata.xml')
      .reply(200, 'non-sense');
    httpMock
      .scope('https://unknown_error')
      .get('/org/example/package/maven-metadata.xml')
      .replyWithError('unknown');

    const res = await get(
      'org.example:package',
      'https://failed_repo/',
      'https://unauthorized_repo/',
      'https://empty_repo',
      'https://unknown_error',
      baseUrl
    );

    expect(res).toMatchSnapshot();
    expect(httpMock.getTrace()).toMatchSnapshot();
  });

  it('ignores unsupported protocols', async () => {
    const base = baseUrl.replace('https', 'http');
    mockGenericPackage({ base });

    const { releases } = await get(
      'org.example:package',
      'ftp://protocol_error_repo',
      's3://protocol_error_repo',
      base
    );

    expect(releases).toMatchSnapshot();
    expect(httpMock.getTrace()).toMatchSnapshot();
  });

  it('skips registry with invalid metadata structure', async () => {
    mockGenericPackage();
    httpMock
      .scope('https://invalid_metadata_repo')
      .get('/org/example/package/maven-metadata.xml')
      .reply(
        200,
        loadFixture('metadata-invalid.xml', upath.join('..', 'maven'))
      );

    const res = await get(
      'org.example:package',
      'https://invalid_metadata_repo',
      baseUrl
    );

    expect(res).toMatchSnapshot();
    expect(httpMock.getTrace()).toMatchSnapshot();
  });

  it('skips registry with invalid XML', async () => {
    mockGenericPackage();
    httpMock
      .scope('https://invalid_metadata_repo')
      .get('/org/example/package/maven-metadata.xml')
      .reply(200, '###');

    const res = await get(
      'org.example:package',
      'https://invalid_metadata_repo',
      baseUrl
    );

    expect(res).toMatchSnapshot();
    expect(httpMock.getTrace()).toMatchSnapshot();
  });

  it('handles optional slash at the end of registry url', async () => {
    mockGenericPackage();
    const resA = await get('org.example:package', baseUrl.replace(/\/+$/, ''));
    mockGenericPackage();
    const resB = await get('org.example:package', baseUrl.replace(/\/*$/, '/'));
    expect(resA).not.toBeNull();
    expect(resB).not.toBeNull();
    expect(resA.releases).toEqual(resB.releases);
    expect(httpMock.getTrace()).toMatchSnapshot();
  });

  it('returns null for invalid registryUrls', async () => {
    const res = await get(
      'org.example:package',
      // eslint-disable-next-line no-template-curly-in-string
      '${project.baseUri}../../repository/'
    );
    expect(res).toBeNull();
  });

  it('supports scm.url values prefixed with "scm:"', async () => {
    const pom = loadFixture('pom.scm-prefix.xml', upath.join('..', 'maven'));
    mockGenericPackage({ pom });

    httpMock
      .scope('https://repo.maven.apache.org')
      .get('/maven2/org/example/package/maven-metadata.xml')
      .reply(200, '###');

    const { sourceUrl } = await get();

    expect(sourceUrl).toEqual('https://github.com/example/test');
  });
});
