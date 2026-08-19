{
    "patcher": {
        "fileversion": 1,
        "appversion": {
            "major": 9,
            "minor": 1,
            "revision": 5,
            "architecture": "x64",
            "modernui": 1
        },
        "classnamespace": "box",
        "rect": [ 80.0, 80.0, 1100.0, 720.0 ],
        "boxes": [
            {
                "box": {
                    "id": "obj-title",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 18.0, 16.0, 520.0, 20.0 ],
                    "text": "EchoScape web bridge — keep this patch open with EchoScape-demo"
                }
            },
            {
                "box": {
                    "id": "obj-help",
                    "linecount": 4,
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 18.0, 40.0, 488.0, 62.0 ],
                    "text": "OSC: /mixer/xy live mixer, /mixer/touch raw pad, /mixer/dpad label, /fx/select face button, /fx/stick scaled left-stick into that plugin, /fx/raw unscaled left stick, /fx/name live vst~ plugin name."
                }
            },
            {
                "box": {
                    "id": "obj-rx",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 18.0, 128.0, 91.0, 22.0 ],
                    "text": "r mixer_x"
                }
            },
            {
                "box": {
                    "id": "obj-ry",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 132.0, 128.0, 91.0, 22.0 ],
                    "text": "r mixer_y"
                }
            },
            {
                "box": {
                    "id": "obj-fx",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "float" ],
                    "patching_rect": [ 18.0, 164.0, 29.5, 22.0 ],
                    "text": "f"
                }
            },
            {
                "box": {
                    "id": "obj-fy",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "float" ],
                    "patching_rect": [ 132.0, 164.0, 29.5, 22.0 ],
                    "text": "f"
                }
            },
            {
                "box": {
                    "id": "obj-pack-xy",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 18.0, 196.0, 67.0, 22.0 ],
                    "text": "pack 0. 0."
                }
            },
            {
                "box": {
                    "id": "obj-metro-xy",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "bang" ],
                    "patching_rect": [ 90.0, 164.0, 65.0, 22.0 ],
                    "text": "metro 16"
                }
            },
            {
                "box": {
                    "id": "obj-trig-xy",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 2,
                    "outlettype": [ "bang", "bang" ],
                    "patching_rect": [ 90.0, 188.0, 46.0, 22.0 ],
                    "text": "t b b"
                }
            },
            {
                "box": {
                    "id": "obj-pre-xy",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 18.0, 228.0, 104.0, 22.0 ],
                    "text": "prepend /mixer/xy"
                }
            },
            {
                "box": {
                    "id": "obj-tx",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 260.0, 128.0, 113.0, 22.0 ],
                    "text": "r touchpad_x"
                }
            },
            {
                "box": {
                    "id": "obj-ty",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 388.0, 128.0, 113.0, 22.0 ],
                    "text": "r touchpad_y"
                }
            },
            {
                "box": {
                    "id": "obj-pak-touch",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 260.0, 164.0, 55.0, 22.0 ],
                    "text": "pak 0. 0."
                }
            },
            {
                "box": {
                    "id": "obj-lim-touch",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 260.0, 196.0, 76.0, 22.0 ],
                    "text": "speedlim 16"
                }
            },
            {
                "box": {
                    "id": "obj-pre-touch",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 260.0, 228.0, 121.0, 22.0 ],
                    "text": "prepend /mixer/touch"
                }
            },
            {
                "box": {
                    "id": "obj-du",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 18.0, 292.0, 85.0, 22.0 ],
                    "text": "r dpad_up"
                }
            },
            {
                "box": {
                    "id": "obj-dd",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 132.0, 292.0, 100.0, 22.0 ],
                    "text": "r dpad_down"
                }
            },
            {
                "box": {
                    "id": "obj-dl",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 260.0, 292.0, 87.0, 22.0 ],
                    "text": "r dpad_left"
                }
            },
            {
                "box": {
                    "id": "obj-dr",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 376.0, 292.0, 95.0, 22.0 ],
                    "text": "r dpad_right"
                }
            },
            {
                "box": {
                    "id": "obj-pre-du",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 18.0, 324.0, 135.0, 22.0 ],
                    "text": "prepend /mixer/dpad up"
                }
            },
            {
                "box": {
                    "id": "obj-pre-dd",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 132.0, 356.0, 151.0, 22.0 ],
                    "text": "prepend /mixer/dpad down"
                }
            },
            {
                "box": {
                    "id": "obj-pre-dl",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 260.0, 324.0, 140.0, 22.0 ],
                    "text": "prepend /mixer/dpad left"
                }
            },
            {
                "box": {
                    "id": "obj-pre-dr",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 376.0, 356.0, 148.0, 22.0 ],
                    "text": "prepend /mixer/dpad right"
                }
            },
            {
                "box": {
                    "id": "obj-udp",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 18.0, 412.0, 148.0, 22.0 ],
                    "text": "udpsend 127.0.0.1 9000"
                }
            },
            {
                "box": {
                    "id": "obj-lb",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "bang" ],
                    "patching_rect": [ 18.0, 448.0, 58.0, 22.0 ],
                    "text": "loadbang"
                }
            },
            {
                "box": {
                    "id": "obj-status",
                    "maxclass": "message",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 18.0, 480.0, 360.0, 22.0 ],
                    "text": "EchoScape web bridge sending OSC to 127.0.0.1:9000"
                }
            },
            {
                "box": {
                    "id": "obj-print",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 18.0, 512.0, 34.0, 22.0 ],
                    "text": "print"
                }
            },
            {
                "box": {
                    "id": "obj-xy-num",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 18.0, 108.0, 184.0, 20.0 ],
                    "text": "live mixer (soundscape_selector)"
                }
            },
            {
                "box": {
                    "id": "obj-touch-num",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 260.0, 108.0, 200.0, 20.0 ],
                    "text": "raw touchpad (no d-pad snaps)"
                }
            },
            {
                "box": {
                    "id": "obj-fx-lab",
                    "maxclass": "comment",
                    "numinlets": 1,
                    "numoutlets": 0,
                    "patching_rect": [ 540.0, 16.0, 280.0, 20.0 ],
                    "text": "face FX (which plugin is in the gate)"
                }
            },
            {
                "box": {
                    "id": "obj-bc",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 40.0, 79.0, 22.0 ],
                    "text": "r cross"
                }
            },
            {
                "box": {
                    "id": "obj-bsq",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 68.0, 87.0, 22.0 ],
                    "text": "r square"
                }
            },
            {
                "box": {
                    "id": "obj-bt",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 96.0, 90.0, 22.0 ],
                    "text": "r triangle"
                }
            },
            {
                "box": {
                    "id": "obj-bo",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 124.0, 79.0, 22.0 ],
                    "text": "r circle"
                }
            },
            {
                "box": {
                    "id": "obj-bst",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 152.0, 74.0, 22.0 ],
                    "text": "r start"
                }
            },
            {
                "box": {
                    "id": "obj-pre-bc",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 700.0, 40.0, 148.0, 22.0 ],
                    "text": "prepend /fx/select/cross"
                }
            },
            {
                "box": {
                    "id": "obj-pre-bsq",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 700.0, 68.0, 156.0, 22.0 ],
                    "text": "prepend /fx/select/square"
                }
            },
            {
                "box": {
                    "id": "obj-pre-bt",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 700.0, 96.0, 159.0, 22.0 ],
                    "text": "prepend /fx/select/triangle"
                }
            },
            {
                "box": {
                    "id": "obj-pre-bo",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 700.0, 124.0, 148.0, 22.0 ],
                    "text": "prepend /fx/select/circle"
                }
            },
            {
                "box": {
                    "id": "obj-pre-bst",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 700.0, 152.0, 148.0, 22.0 ],
                    "text": "prepend /fx/select/cross"
                }
            },
            {
                "box": {
                    "id": "obj-lx",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 196.0, 79.0, 22.0 ],
                    "text": "r left_x"
                }
            },
            {
                "box": {
                    "id": "obj-ly",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 668.0, 196.0, 79.0, 22.0 ],
                    "text": "r left_y"
                }
            },
            {
                "box": {
                    "id": "obj-pak-raw",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 228.0, 55.0, 22.0 ],
                    "text": "pak 0. 0."
                }
            },
            {
                "box": {
                    "id": "obj-lim-raw",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 256.0, 76.0, 22.0 ],
                    "text": "speedlim 16"
                }
            },
            {
                "box": {
                    "id": "obj-pre-raw",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 284.0, 89.0, 22.0 ],
                    "text": "prepend /fx/raw"
                }
            },
            {
                "box": {
                    "id": "obj-cx",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 328.0, 91.0, 22.0 ],
                    "text": "r fx_cross_x"
                }
            },
            {
                "box": {
                    "id": "obj-cy",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 668.0, 328.0, 91.0, 22.0 ],
                    "text": "r fx_cross_y"
                }
            },
            {
                "box": {
                    "id": "obj-pak-c",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 356.0, 55.0, 22.0 ],
                    "text": "pak 0. 0."
                }
            },
            {
                "box": {
                    "id": "obj-lim-c",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 384.0, 76.0, 22.0 ],
                    "text": "speedlim 16"
                }
            },
            {
                "box": {
                    "id": "obj-pre-c",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 412.0, 148.0, 22.0 ],
                    "text": "prepend /fx/stick/cross"
                }
            },
            {
                "box": {
                    "id": "obj-sqx",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 780.0, 328.0, 99.0, 22.0 ],
                    "text": "r fx_square_x"
                }
            },
            {
                "box": {
                    "id": "obj-sqy",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 908.0, 328.0, 99.0, 22.0 ],
                    "text": "r fx_square_y"
                }
            },
            {
                "box": {
                    "id": "obj-pak-sq",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 780.0, 356.0, 55.0, 22.0 ],
                    "text": "pak 0. 0."
                }
            },
            {
                "box": {
                    "id": "obj-lim-sq",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 780.0, 384.0, 76.0, 22.0 ],
                    "text": "speedlim 16"
                }
            },
            {
                "box": {
                    "id": "obj-pre-sq",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 780.0, 412.0, 156.0, 22.0 ],
                    "text": "prepend /fx/stick/square"
                }
            },
            {
                "box": {
                    "id": "obj-trx",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 456.0, 106.0, 22.0 ],
                    "text": "r fx_triangle_x"
                }
            },
            {
                "box": {
                    "id": "obj-try",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 668.0, 456.0, 106.0, 22.0 ],
                    "text": "r fx_triangle_y"
                }
            },
            {
                "box": {
                    "id": "obj-pak-tr",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 484.0, 55.0, 22.0 ],
                    "text": "pak 0. 0."
                }
            },
            {
                "box": {
                    "id": "obj-lim-tr",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 512.0, 76.0, 22.0 ],
                    "text": "speedlim 16"
                }
            },
            {
                "box": {
                    "id": "obj-pre-tr",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 540.0, 159.0, 22.0 ],
                    "text": "prepend /fx/stick/triangle"
                }
            },
            {
                "box": {
                    "id": "obj-ox",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 780.0, 456.0, 93.0, 22.0 ],
                    "text": "r fx_circle_x"
                }
            },
            {
                "box": {
                    "id": "obj-oy",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 908.0, 456.0, 93.0, 22.0 ],
                    "text": "r fx_circle_y"
                }
            },
            {
                "box": {
                    "id": "obj-pak-o",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 780.0, 484.0, 55.0, 22.0 ],
                    "text": "pak 0. 0."
                }
            },
            {
                "box": {
                    "id": "obj-lim-o",
                    "maxclass": "newobj",
                    "numinlets": 2,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 780.0, 512.0, 76.0, 22.0 ],
                    "text": "speedlim 16"
                }
            },
            {
                "box": {
                    "id": "obj-pre-o",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 780.0, 540.0, 148.0, 22.0 ],
                    "text": "prepend /fx/stick/circle"
                }
            },
            {
                "box": {
                    "id": "obj-nx",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 580.0, 107.0, 22.0 ],
                    "text": "r fx_name_cross"
                }
            },
            {
                "box": {
                    "id": "obj-nsq",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 668.0, 580.0, 115.0, 22.0 ],
                    "text": "r fx_name_square"
                }
            },
            {
                "box": {
                    "id": "obj-ntr",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 800.0, 580.0, 122.0, 22.0 ],
                    "text": "r fx_name_triangle"
                }
            },
            {
                "box": {
                    "id": "obj-no",
                    "maxclass": "newobj",
                    "numinlets": 0,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 940.0, 580.0, 109.0, 22.0 ],
                    "text": "r fx_name_circle"
                }
            },
            {
                "box": {
                    "id": "obj-pre-nx",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 540.0, 608.0, 148.0, 22.0 ],
                    "text": "prepend /fx/name/cross"
                }
            },
            {
                "box": {
                    "id": "obj-pre-nsq",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 668.0, 608.0, 156.0, 22.0 ],
                    "text": "prepend /fx/name/square"
                }
            },
            {
                "box": {
                    "id": "obj-pre-ntr",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 800.0, 608.0, 159.0, 22.0 ],
                    "text": "prepend /fx/name/triangle"
                }
            },
            {
                "box": {
                    "id": "obj-pre-no",
                    "maxclass": "newobj",
                    "numinlets": 1,
                    "numoutlets": 1,
                    "outlettype": [ "" ],
                    "patching_rect": [ 940.0, 608.0, 148.0, 22.0 ],
                    "text": "prepend /fx/name/circle"
                }
            }
        ],
        "lines": [
            {
                "patchline": {
                    "destination": [ "obj-pre-dd", 0 ],
                    "source": [ "obj-dd", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-dl", 0 ],
                    "source": [ "obj-dl", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-dr", 0 ],
                    "source": [ "obj-dr", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-du", 0 ],
                    "source": [ "obj-du", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-status", 0 ],
                    "order": 1,
                    "source": [ "obj-lb", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-metro-xy", 0 ],
                    "order": 0,
                    "source": [ "obj-lb", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-touch", 0 ],
                    "source": [ "obj-lim-touch", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-xy", 0 ],
                    "source": [ "obj-pack-xy", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-lim-touch", 0 ],
                    "source": [ "obj-pak-touch", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-trig-xy", 0 ],
                    "source": [ "obj-metro-xy", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-fx", 0 ],
                    "source": [ "obj-trig-xy", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-fy", 0 ],
                    "source": [ "obj-trig-xy", 1 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pack-xy", 0 ],
                    "source": [ "obj-fx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pack-xy", 1 ],
                    "source": [ "obj-fy", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-dd", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-dl", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-dr", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-du", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-touch", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-xy", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-fx", 1 ],
                    "source": [ "obj-rx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-fy", 1 ],
                    "source": [ "obj-ry", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-print", 0 ],
                    "source": [ "obj-status", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-touch", 0 ],
                    "source": [ "obj-tx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-touch", 1 ],
                    "source": [ "obj-ty", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-bc", 0 ],
                    "source": [ "obj-bc", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-bsq", 0 ],
                    "source": [ "obj-bsq", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-bt", 0 ],
                    "source": [ "obj-bt", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-bo", 0 ],
                    "source": [ "obj-bo", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-bst", 0 ],
                    "source": [ "obj-bst", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-raw", 0 ],
                    "source": [ "obj-lx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-raw", 1 ],
                    "source": [ "obj-ly", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-lim-raw", 0 ],
                    "source": [ "obj-pak-raw", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-raw", 0 ],
                    "source": [ "obj-lim-raw", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-c", 0 ],
                    "source": [ "obj-cx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-c", 1 ],
                    "source": [ "obj-cy", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-lim-c", 0 ],
                    "source": [ "obj-pak-c", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-c", 0 ],
                    "source": [ "obj-lim-c", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-sq", 0 ],
                    "source": [ "obj-sqx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-sq", 1 ],
                    "source": [ "obj-sqy", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-lim-sq", 0 ],
                    "source": [ "obj-pak-sq", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-sq", 0 ],
                    "source": [ "obj-lim-sq", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-tr", 0 ],
                    "source": [ "obj-trx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-tr", 1 ],
                    "source": [ "obj-try", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-lim-tr", 0 ],
                    "source": [ "obj-pak-tr", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-tr", 0 ],
                    "source": [ "obj-lim-tr", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-o", 0 ],
                    "source": [ "obj-ox", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pak-o", 1 ],
                    "source": [ "obj-oy", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-lim-o", 0 ],
                    "source": [ "obj-pak-o", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-o", 0 ],
                    "source": [ "obj-lim-o", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-bc", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-bsq", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-bt", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-bo", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-bst", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-raw", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-c", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-sq", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-tr", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-o", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-nx", 0 ],
                    "source": [ "obj-nx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-nsq", 0 ],
                    "source": [ "obj-nsq", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-ntr", 0 ],
                    "source": [ "obj-ntr", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-pre-no", 0 ],
                    "source": [ "obj-no", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-nx", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-nsq", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-ntr", 0 ]
                }
            },
            {
                "patchline": {
                    "destination": [ "obj-udp", 0 ],
                    "source": [ "obj-pre-no", 0 ]
                }
            }
        ],
        "autosave": 0
    }
}