// NOTE Sets the release version of the package. Used by .github/workflows/release.yml.
// A version that is already on npm gets a minor bump. Other versions are manual bumps.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const getPublishedVersions = (name) => {
  try {
    const versions = JSON.parse(
      execFileSync('npm', ['view', name, 'versions', '--json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );

    // NOTE npm gives a string, not an array, when there is only one version
    return [].concat(versions);
  } catch (error) {
    if (`${error.stdout}${error.stderr}`.includes('E404')) {
      return [];
    }

    throw error;
  }
};

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const getRemoteTagCommit = (tag) =>
  git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`).split('\t')[0];

const bumpMinor = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);

  if (!match) {
    throw new Error(`Version ${version} is not x.y.z, cannot bump it`);
  }

  return `${match[1]}.${Number(match[2]) + 1}.0`;
};

const packageJson = readJson('package.json');
const lockJson = readJson('package-lock.json');
const { name, version } = packageJson;
const head = git('rev-parse', 'HEAD');

// NOTE The release tag is on HEAD when an earlier run failed after the push. Do not bump again.
const resume = getRemoteTagCommit(`v${version}`) === head;

if (resume) {
  console.log(`Tag v${version} is on HEAD. Continue that release, no version bump`);
}

const npmVersions = getPublishedVersions(name);
const bumped = !resume && npmVersions.includes(version);

if (bumped) {
  packageJson.version = bumpMinor(version);

  if (npmVersions.includes(packageJson.version)) {
    throw new Error(
      `${name}@${packageJson.version} is already on npm. Run from the latest main, or set the version manually`,
    );
  }
}

console.log(`${name}: ${version} -> ${packageJson.version} (${bumped ? 'minor bump' : 'manual'})`);

const tag = `v${packageJson.version}`;
const tagCommit = getRemoteTagCommit(tag);

if (tagCommit && tagCommit !== head) {
  throw new Error(`Tag ${tag} is on another commit. Set the version manually`);
}

lockJson.version = packageJson.version;
lockJson.packages[''].version = packageJson.version;
writeJson('package.json', packageJson);
writeJson('package-lock.json', lockJson);

const notes = `\`${name}\` ${packageJson.version}`;

console.log(`Tag: ${tag}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [`tag=${tag}`, 'notes<<RELEASE_NOTES', notes, 'RELEASE_NOTES', ''].join('\n'),
  );
}
