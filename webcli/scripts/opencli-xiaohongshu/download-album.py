#!/usr/bin/env python3
"""Download an explicitly selected Xiaohongshu album using WebCLI and yt-dlp."""
import argparse
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import urlparse


def call(cli, command, **params):
    result = subprocess.run([cli, 'call', 'xiaohongshu.com.' + command,
        '--output-format=json', *['--' + k.replace('_', '-') + '=' + str(v) for k, v in params.items()]],
        text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError('WebCLI ' + command + ' failed; inspect the browser and login state')
    data = json.loads(result.stdout)
    if data.get('ok') is False or data.get('error'):
        raise RuntimeError('WebCLI ' + command + ' returned an error')
    return data


def download(cli, album_id, output):
    album = call(cli, 'album-notes', album_id=album_id, limit=1000)
    if not album.get('complete'):
        raise RuntimeError('Album pagination incomplete; refusing a partial album download')
    output.mkdir(parents=True, exist_ok=True)
    videos = [n for n in album['notes'] if n['type'] == 'video']
    for note in videos:
        if not re.fullmatch(r'[a-f0-9]{24}', note['id']):
            raise RuntimeError('Invalid note ID')
        media = call(cli, 'video-media', url=note['url'])
        streams = sorted(media['streams'], key=lambda s: s.get('height', 0), reverse=True)
        url = streams[0]['url']
        host = urlparse(url).hostname or ''
        if urlparse(url).scheme != 'https' or not (host == 'xhscdn.com' or host.endswith('.xhscdn.com')):
            raise RuntimeError('Unexpected media host')
        target = output / (note['id'] + '.mp4')
        # Capture subprocess output so temporary signed media URLs are not logged.
        result = subprocess.run(['yt-dlp', '--quiet', '--no-warnings', '--no-overwrites',
            '--referer', 'https://www.xiaohongshu.com/', '-o', str(target), url], capture_output=True)
        if result.returncode:
            raise RuntimeError('yt-dlp failed for note ' + note['id'])
        probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries',
            'stream=codec_type', '-of', 'json', str(target)], capture_output=True, text=True, check=True)
        types = {s['codec_type'] for s in json.loads(probe.stdout)['streams']}
        if not {'video', 'audio'} <= types:
            raise RuntimeError('Downloaded file lacks video or audio')
        print(json.dumps({'id': note['id'], 'file': str(target), 'bytes': target.stat().st_size,
                          'verified_audio_video': True}, ensure_ascii=False))
    print(json.dumps({'album': album['album']['name'], 'downloaded_videos': len(videos),
                      'skipped_non_videos': len(album['notes']) - len(videos)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--webcli', default='/Applications/WeWorker.app/Contents/Resources/webcli/webcli')
    parser.add_argument('--album-id', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    download(args.webcli, args.album_id, args.output.expanduser().resolve())
