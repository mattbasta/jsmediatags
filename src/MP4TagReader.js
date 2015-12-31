/**
 * Support for iTunes-style m4a tags
 * See:
 *   http://atomicparsley.sourceforge.net/mpeg-4files.html
 *   http://developer.apple.com/mac/library/documentation/QuickTime/QTFF/Metadata/Metadata.html
 * Authored by Joshua Kifer <joshua.kifer gmail.com>
 * @flow
 */
'use strict';

var MediaTagReader = require('./MediaTagReader');
var MediaFileReader = require('./MediaFileReader');

import type {
  CallbackType,
  LoadCallbackType,
  CharsetType,
  ByteRange
} from './FlowTypes';

class MP4TagReader extends MediaTagReader {
  static getTagIdentifierByteRange(): ByteRange {
    // The tag identifier is located in [4, 11] but since we'll need to reader
    // the header of the first block anyway, we load it instead to avoid
    // making two requests.
    return {
      offset: 0,
      length: 11
    };
  }

  static canReadTagFormat(tagIdentifier: Array<number>): boolean {
    var id = String.fromCharCode.apply(String, tagIdentifier.slice(4, 11));
    return id === "ftypM4A";
  }

  _loadData(mediaFileReader: MediaFileReader, callbacks: LoadCallbackType) {
    // MP4 metadata isn't located in a specific location of the file. Roughly
    // speaking, it's composed of blocks chained together like a linked list.
    // These blocks are called atoms (or boxes).
    // Each atom of the list can have its own child linked list. Atoms in this
    // situation do not possess any data and are called "container" as they only
    // contain other atoms.
    // Other atoms represent a particular set of data, like audio, video or
    // metadata. In order to find and load all the interesting atoms we need
    // to traverse the entire linked list of atoms and only load the ones
    // associated with metadata.
    // The metadata atoms can be find under the "moov.udta.meta.ilst" hierarchy.

    var self = this;
    // load the header of the first atom
    mediaFileReader.loadRange([0, 7], {
      onSuccess: function() {
        self._loadAtom(mediaFileReader, 0, "", callbacks);
      },
      onError: callbacks.onError
    });
  }

  _loadAtom(
    mediaFileReader: MediaFileReader,
    offset: number,
    parentAtomFullName: string,
    callbacks: LoadCallbackType
  ) {
    if (offset >= mediaFileReader.getSize()) {
      callbacks.onSuccess();
      return;
    }

    var self = this;
    // 8 is the size of the atomSize and atomName fields.
    // When reading the current block we always read 8 more bytes in order
    // to also read the header of the next block.
    var atomSize = mediaFileReader.getLongAt(offset, true);
    if (atomSize == 0 || isNaN(atomSize)) {
      callbacks.onSuccess();
      return;
    }
    var atomName = mediaFileReader.getStringAt(offset + 4, 4);

    // Container atoms (no actual data)
    if (this._isContainerAtom(atomName)) {
      if (atomName == "meta") {
        // The "meta" atom breaks convention and is a container with data.
        offset += 4; // next_item_id (uint32)
      }
      var atomFullName = (parentAtomFullName ? parentAtomFullName+"." : "") + atomName;
      mediaFileReader.loadRange([offset+8, offset+8 + 8], {
        onSuccess: function() {
          self._loadAtom(mediaFileReader, offset + 8, atomFullName, callbacks);
        },
        onError: callbacks.onError
      });
    } else {
      // Value atoms
      var shouldReadAtom = parentAtomFullName === "moov.udta.meta.ilst";
      mediaFileReader.loadRange(
        [offset+(shouldReadAtom?0:atomSize), offset+atomSize + 8],
        {
          onSuccess: function() {
            self._loadAtom(mediaFileReader, offset+atomSize, parentAtomFullName, callbacks);
          },
          onError: callbacks.onError
        }
      );
    }
  }

  _isContainerAtom(atomName: string): boolean {
    return ["moov", "udta", "meta", "ilst"].indexOf(atomName) >= 0;
  }

  _canReadAtom(atomName: string): boolean {
    return atomName !== "----";
  }

  _parseData(data: MediaFileReader, tags: ?Array<string>): Object {
    var tag = {};
    this._readAtom(tag, data, 0, data.getSize());
    return tag;
  }

  _readAtom(
    tag: Object,
    data: MediaFileReader,
    offset: number,
    length: number,
    parentAtomFullName?: string,
    indent?: string
  ) {
    indent = indent === undefined ? "" : indent + "  ";

    var seek = offset;
    while (seek < offset + length) {
      var atomSize = data.getLongAt(seek, true);
      if (atomSize == 0) {
        return;
      }
      var atomName = data.getStringAt(seek + 4, 4);
      // console.log(indent + atomName, parentAtomFullName, atomSize);
      if (this._isContainerAtom(atomName)) {
        if (atomName == "meta") {
          seek += 4; // next_item_id (uint32)
        }
        var atomFullName = (parentAtomFullName ? parentAtomFullName+"." : "") + atomName;
        this._readAtom(tag, data, seek + 8, atomSize - 8, atomFullName, indent);
        return;
      }

      // Value atoms
      if (
        parentAtomFullName === "moov.udta.meta.ilst" &&
        this._canReadAtom(atomName)
      ) {
        var klass = data.getInteger24At(seek + 16 + 1, true);
        var atom = ATOMS[atomName];
        var type = TYPES[klass];

        if (atomName == "trkn") {
          tag[atomName] = data.getByteAt(seek + 16 + 11);
          tag["count"] = data.getByteAt(seek + 16 + 13);
        } else {
          // 16: name + size + "data" + size (4 bytes each)
          // 4: atom version (1 byte) + atom flags (3 bytes)
          // 4: NULL (usually locale indicator)
          var atomHeader = 16 + 4 + 4;
          var dataStart = seek + atomHeader;
          var dataLength = atomSize - atomHeader;
          var atomData;

          switch (type) {
            case "text":
            atomData = data.getStringWithCharsetAt(dataStart, dataLength, "utf-8").toString();
            break;

            case "uint8":
            atomData = data.getShortAt(dataStart, false);
            break;

            case "jpeg":
            case "png":
            atomData = {
              "format": "image/" + type,
              "data": data.getBytesAt(dataStart, dataLength)
            };
            break;
          }

          if (atomName === "©cmt") {
            tag[atomName] = {
              "text": atomData
            };
          } else {
            tag[atomName] = atomData;
          }
        }
      }
      seek += atomSize;
    }
  }
}

const TYPES = {
  "0": "uint8",
  "1": "text",
  "13": "jpeg",
  "14": "png",
  "21": "uint8"
};

const ATOMS = {
  "©alb": ["album"],
  "©art": ["artist"],
  "©ART": ["artist"],
  "aART": ["artist"],
  "©day": ["year"],
  "©nam": ["title"],
  "©gen": ["genre"],
  "trkn": ["track"],
  "©wrt": ["composer"],
  "©too": ["encoder"],
  "cprt": ["copyright"],
  "covr": ["picture"],
  "©grp": ["grouping"],
  "keyw": ["keyword"],
  "©lyr": ["lyrics"],
  "©cmt": ["comment"],
  "tmpo": ["tempo"],
  "cpil": ["compilation"],
  "disk": ["disc"]
};

const UNSUPPORTED_ATOMS = {
  "----": 1,
}

module.exports = MP4TagReader;
