import sys
import json
import os
import re
import subprocess
from chat_downloader import ChatDownloader

def create_netscape_cookies_file(cookie_str, file_path):
    """
    Converts a standard browser Cookie header string (semicolon-separated name-value pairs)
    into the tab-separated Netscape cookie file format expected by yt-dlp and chat-downloader.
    """
    try:
        # Clean the cookie string: remove any newlines, carriage returns, or enclosing quotes
        cookie_str = cookie_str.replace('\r', '').replace('\n', '').strip()
        if cookie_str.startswith('"') and cookie_str.endswith('"'):
            cookie_str = cookie_str[1:-1]
        if cookie_str.startswith("'") and cookie_str.endswith("'"):
            cookie_str = cookie_str[1:-1]
            
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write("# Netscape HTTP Cookie File\n")
            f.write("# This file is generated dynamically from YOUTUBE_COOKIE\n")
            
            pairs = cookie_str.split(';')
            for pair in pairs:
                pair = pair.strip()
                if '=' not in pair:
                    continue
                name, value = pair.split('=', 1)
                name = name.strip()
                value = value.strip()
                # Domain, Include subdomains, Path, Secure, Expiration, Name, Value
                f.write(f".youtube.com\tTRUE\t/\tTRUE\t0\t{name}\t{value}\n")
        return True
    except Exception as e:
        sys.stderr.write(f"[Python Cookies Parser] Error writing netscape cookies file: {str(e)}\n")
        sys.stderr.flush()
        return False

def parse_yt_dlp_chat(file_path):
    messages = []
    if not os.path.exists(file_path):
        return messages
        
    with open(file_path, 'r', encoding='utf-8') as f:
        for line in f:
            try:
                data = json.loads(line)
                action = data.get('replayChatItemAction', {})
                actions = action.get('actions', [])
                for act in actions:
                    add_chat = act.get('addChatItemAction', {})
                    item = add_chat.get('item', {})
                    renderer = item.get('liveChatTextMessageRenderer', {})
                    if not renderer:
                        continue
                    
                    # Extract message text from runs
                    message_text = ""
                    runs = renderer.get('message', {}).get('runs', [])
                    for run in runs:
                        if 'text' in run:
                            message_text += run['text']
                            
                    # Extract timestamp (microseconds to milliseconds)
                    timestamp_usec = renderer.get('timestampUsec')
                    timestamp = int(timestamp_usec) // 1000 if timestamp_usec else None
                    
                    # Time in video (seconds)
                    offset_msec = action.get('videoOffsetTimeMsec')
                    time_in_seconds = int(offset_msec) / 1000 if offset_msec else None
                    
                    # Author info
                    author = renderer.get('authorName', {}).get('simpleText')
                    author_id = renderer.get('authorExternalChannelId')
                    
                    # Check if streamer/owner
                    badges = renderer.get('authorBadges', [])
                    is_streamer = False
                    for badge in badges:
                        badge_renderer = badge.get('liveChatAuthorBadgeRenderer', {})
                        icon = badge_renderer.get('icon', {})
                        if icon.get('iconType') == 'OWNER':
                            is_streamer = True
                            break
                    
                    messages.append({
                        'timestamp': timestamp,
                        'time_in_video': time_in_seconds,
                        'author': author,
                        'message': message_text,
                        'is_streamer': is_streamer
                    })
            except Exception:
                continue
    return messages

def get_archived_chat_ytdlp(video_url, cookies_path=None, proxy_url=None, user_agent=None):
    match = re.search(r'(?:v=|\/live\/|\/v\/|embed\/|youtu\.be\/)([0-9A-Za-z_-]{11})', video_url)
    if not match:
        raise Exception("Invalid video URL format for yt-dlp")
    video_id = match.group(1)
    
    # Run yt-dlp command
    temp_output_prefix = f"temp_chat_{video_id}"
    expected_file = f"{temp_output_prefix}.live_chat.json"
    
    if os.path.exists(expected_file):
        os.remove(expected_file)
        
    try:
        # Build command options
        cmd = ["yt-dlp", "--write-subs", "--sub-langs", "live_chat", "--skip-download", "--output", temp_output_prefix]
        if cookies_path:
            cmd.extend(["--cookies", cookies_path])
        if proxy_url:
            cmd.extend(["--proxy", proxy_url])
        if user_agent:
            cmd.extend(["--user-agent", user_agent])
        cmd.append(video_url)
        
        # Run yt-dlp using subprocess
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise Exception(f"yt-dlp execution failed (code {result.returncode}): {result.stderr.strip()}")
        
        if not os.path.exists(expected_file):
            raise Exception("yt-dlp execution did not generate a live chat JSON file")
            
        return parse_yt_dlp_chat(expected_file)
    finally:
        if os.path.exists(expected_file):
            os.remove(expected_file)

def get_archived_chat(video_url):
    cookie_str = os.environ.get('YOUTUBE_COOKIE')
    proxy_url = os.environ.get('PROXY_URL')
    
    # If cookie is present, bypass the proxy to avoid rate limits / connection issues
    if cookie_str and proxy_url:
        sys.stderr.write("[Python Scraper] Cookie is present. Bypassing PROXY_URL.\n")
        sys.stderr.flush()
        proxy_url = None
        
    user_agent = os.environ.get('YOUTUBE_USER_AGENT')
    if not user_agent:
        user_agent = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36"
    
    match = re.search(r'(?:v=|\/live\/|\/v\/|embed\/|youtu\.be\/)([0-9A-Za-z_-]{11})', video_url)
    video_id = match.group(1) if match else "unknown"
    
    cookies_path = f"temp_cookies_{video_id}.txt"
    cookies_created = False
    
    if cookie_str:
        cookies_created = create_netscape_cookies_file(cookie_str, cookies_path)
    
    try:
        sys.stderr.write("Initializing chat-downloader...\n")
        sys.stderr.flush()
        
        # Build ChatDownloader configurations
        downloader_opts = {}
        if cookies_created:
            downloader_opts['cookies'] = cookies_path
        if proxy_url:
            downloader_opts['proxy'] = proxy_url
        if user_agent:
            downloader_opts['headers'] = {'User-Agent': user_agent}
            
        downloader = ChatDownloader(**downloader_opts)
        chat = downloader.get_chat(video_url)
        
        messages = []
        count = 0
        for message in chat:
            count += 1
            if count % 100 == 0:
                sys.stderr.write(f"Parsed {count} messages...\n")
                sys.stderr.flush()
                
            is_streamer = 'owner' in message.get('author', {}).get('badges', [])
            
            messages.append({
                'timestamp': message.get('timestamp'),
                'time_in_video': message.get('time_in_seconds'),
                'author': message.get('author', {}).get('name'),
                'message': message.get('message'),
                'is_streamer': is_streamer
            })
            
        print(json.dumps(messages))
      
    except Exception as e:
        sys.stderr.write(f"chat-downloader failed: {str(e)}. Attempting yt-dlp fallback...\n")
        sys.stderr.flush()
        # If chat-downloader fails, fallback to yt-dlp
        try:
            messages = get_archived_chat_ytdlp(video_url, cookies_path if cookies_created else None, proxy_url, user_agent)
            if messages:
                print(json.dumps(messages))
            else:
                print(json.dumps({"error": f"No chat logs retrieved. chat-downloader error: {str(e)}"}))
        except Exception as ytdlp_err:
            print(json.dumps({
                "error": f"Failed to retrieve chat using chat-downloader ({str(e)}) and yt-dlp ({str(ytdlp_err)})"
            }))
    finally:
        # Clean up temporary cookies file
        if cookies_created and os.path.exists(cookies_path):
            try:
                os.remove(cookies_path)
            except Exception:
                pass

if __name__ == '__main__':
    url = sys.argv[1] if len(sys.argv) > 1 else 'https://www.youtube.com/watch?v=5qap5aO4i9A'
    get_archived_chat(url)