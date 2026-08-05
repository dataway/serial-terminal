# Serial Terminal

Demo: https://dataway.github.io/serial-terminal/

Original repository: https://github.com/GoogleChromeLabs/serial-terminal

Adapted by [Anthony Uk](https://anthonyuk.com).

My version simplifies the UI, showing only the options needed by our field staff (Cisco routers).
Only 9600 and 115200 baud is offered, and connections are always 8-N-1.

The terminal responds to the browser window size, doing its best to show at least 80 columns and
25 rows while maintaining legibility.

I also found that under Windows, sending break can cause the entire browser to hang, depending on
the USB adapter. Therefore the break function is disabled under Windows unless the adapter is
whitelisted.

Browser requirements: Chrome 89, Edge 89, Opera 76, or Firefox 151.
