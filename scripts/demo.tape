Output docs/assets/demo.gif

# Optional true terminal capture for machines where VHS can launch its local
# ttyd/Chromium pair. scripts/render-demo-gif.js is the CI-friendly fallback.

Set Shell "bash"
Set Width 1200
Set Height 700
Set FontSize 18
Set Padding 28
Set Framerate 15
Set TypingSpeed 12ms
Set PlaybackSpeed 1
Set Theme { "name": "Catppuccin Mocha", "black": "#181825", "red": "#f38ba8", "green": "#a6e3a1", "yellow": "#f9e2af", "blue": "#89b4fa", "magenta": "#cba6f7", "cyan": "#89dceb", "white": "#cdd6f4", "brightBlack": "#585b70", "brightRed": "#f38ba8", "brightGreen": "#a6e3a1", "brightYellow": "#f9e2af", "brightBlue": "#89b4fa", "brightMagenta": "#cba6f7", "brightCyan": "#89dceb", "brightWhite": "#ffffff", "background": "#111116", "foreground": "#cdd6f4", "selection": "#45475a", "cursor": "#f5e0dc" }

Hide
Type "node scripts/demo-session.js"
Enter
Sleep 450ms
Show
Sleep 9s
